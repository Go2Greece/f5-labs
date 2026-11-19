// Course and lab API. Lab content and the rules that mark a step done come from Atlas.
// The rules are evaluated here on the server and are never sent to the browser.
import { evalRule } from "./rules.js";
import { seed, syncDrafts, SEED_COURSES } from "./seed.js";

function hasAccess(user, courseId) {
  return Array.isArray(user.access) && user.access.includes(courseId);
}

function progressId(user, labId) {
  return user.googleId + "|" + labId;
}

function clone(v) {
  return JSON.parse(JSON.stringify(v));
}

function freshState(lab) {
  const config = clone((lab.initial && lab.initial.config) || {});
  return { config, applied: clone(config), visited: [], tests: {} };
}

// Keep only the parts of client state the engine understands, and bound its size.
function cleanState(lab, input) {
  const base = freshState(lab);
  if (!input || typeof input !== "object") return base;
  const raw = JSON.stringify(input);
  if (raw.length > 60000) return base;
  const s = JSON.parse(raw);
  return {
    config: s.config && typeof s.config === "object" ? s.config : base.config,
    applied: s.applied && typeof s.applied === "object" ? s.applied : base.applied,
    visited: Array.isArray(s.visited) ? s.visited.filter((v) => typeof v === "string").slice(0, 200) : [],
    tests: s.tests && typeof s.tests === "object" ? s.tests : {},
  };
}

function evaluate(lab, state) {
  const steps = {};
  for (const step of lab.steps || []) steps[step.id] = evalRule(step.check, state);
  const complete = (lab.steps || []).length > 0 && Object.values(steps).every(Boolean);
  return { steps, complete };
}

// What the browser is allowed to see: everything except the rules.
function publicLab(lab) {
  return {
    id: lab._id,
    courseId: lab.courseId,
    moduleId: lab.moduleId,
    title: lab.title,
    intro: lab.intro,
    device: lab.device || {},
    applyLabel: lab.applyLabel || "Apply",
    pendingText: lab.pendingText || "Changes not yet applied",
    startScreen: lab.startScreen,
    menu: lab.menu || [],
    screens: lab.screens || {},
    tests: (lab.tests || []).map((t) => ({ id: t.id, label: t.label, request: t.request })),
    steps: (lab.steps || []).map((s) => ({ id: s.id, text: s.text })),
  };
}

export async function getCourse(db, user, courseId) {
  if (!hasAccess(user, courseId)) return { status: 403, body: { error: "You do not have access to this course." } };
  if (SEED_COURSES.some((c) => c._id === courseId && c.draft)) await syncDrafts(db);
  let course = await db.collection("courses").findOne({ _id: courseId });
  if (!course && SEED_COURSES.some((c) => c._id === courseId)) {
    // First time this course is opened: load its records into Atlas. Existing records are never changed.
    await seed(db, false);
    course = await db.collection("courses").findOne({ _id: courseId });
  }
  if (!course) return { status: 404, body: { error: "This course has no content yet." } };
  const labs = await db
    .collection("labs")
    .find({ courseId }, { projection: { title: 1, moduleId: 1, order: 1 } })
    .toArray();
  const done = await db
    .collection("progress")
    .find({ googleId: user.googleId, courseId }, { projection: { labId: 1, complete: 1, steps: 1 } })
    .toArray();
  const byLab = Object.fromEntries(done.map((p) => [p.labId, p]));
  const titles = Object.fromEntries(labs.map((l) => [l._id, l.title]));
  return {
    status: 200,
    body: {
      id: course._id,
      code: course.code,
      version: course.version,
      title: course.title,
      modules: (course.modules || []).map((m) => ({
        id: m.id,
        title: m.title,
        labs: (m.labs || []).map((labId) => {
          const p = byLab[labId];
          const stepValues = p && p.steps ? Object.values(p.steps) : [];
          return {
            id: labId,
            title: titles[labId] || labId,
            available: Boolean(titles[labId]),
            complete: Boolean(p && p.complete),
            stepsDone: stepValues.filter(Boolean).length,
            stepsTotal: stepValues.length,
          };
        }),
      })),
    },
  };
}

async function loadLab(db, user, labId, sync) {
  if (sync) await syncDrafts(db);
  const lab = await db.collection("labs").findOne({ _id: labId });
  if (!lab) return { error: { status: 404, body: { error: "Lab not found." } } };
  if (!hasAccess(user, lab.courseId)) return { error: { status: 403, body: { error: "You do not have access to this lab." } } };
  return { lab };
}

export async function getLab(db, user, labId) {
  const { lab, error } = await loadLab(db, user, labId, true);
  if (error) return error;
  const course = await db.collection("courses").findOne({ _id: lab.courseId });
  const saved = await db.collection("progress").findOne({ _id: progressId(user, labId) });
  const state = saved && saved.state ? cleanState(lab, saved.state) : freshState(lab);
  const module = course && (course.modules || []).find((m) => m.id === lab.moduleId);
  return {
    status: 200,
    body: {
      lab: publicLab(lab),
      breadcrumb: {
        course: course ? course.title : lab.courseId,
        version: course ? "v" + course.version : "",
        module: module ? module.title : lab.moduleId,
        lab: lab.title,
      },
      state,
      ...evaluate(lab, state),
    },
  };
}

// Receives the student's current lab state, runs any requested test, marks the steps, saves progress.
export async function checkLab(db, user, body) {
  const { lab, error } = await loadLab(db, user, body && body.id);
  if (error) return error;
  const state = body.reset ? freshState(lab) : cleanState(lab, body.state);

  let test = null;
  if (!body.reset && body.testId) {
    const def = (lab.tests || []).find((t) => t.id === body.testId);
    if (def) {
      const hit = (def.outcomes || []).find((o) => evalRule(o.when, state)) || def.default || { result: "none", message: "" };
      state.tests[def.id] = hit.result;
      test = { id: def.id, result: hit.result, message: hit.message };
    }
  }

  const result = evaluate(lab, state);
  const now = new Date();
  const update = {
    $set: {
      googleId: user.googleId,
      email: user.email,
      courseId: lab.courseId,
      labId: lab._id,
      state,
      steps: result.steps,
      complete: result.complete,
      updated: now,
    },
    $setOnInsert: { started: now },
  };
  if (result.complete) update.$min = { completedAt: now };
  await db.collection("progress").updateOne({ _id: progressId(user, lab._id) }, update, { upsert: true });
  return { status: 200, body: { state, test, ...result } };
}

export async function runSeed(db, user, replace) {
  if (!user.admin) return { status: 403, body: { error: "Admin only. Set admin: true on your user record in Atlas." } };
  await db.collection("labs").createIndex({ courseId: 1 });
  await db.collection("progress").createIndex({ googleId: 1, courseId: 1 });
  return { status: 200, body: { ok: true, report: await seed(db, replace) } };
}
