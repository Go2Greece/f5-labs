import { withDb, safeError } from "./db.js";
import { login, callback, logout, userFromSession, readCookie } from "./auth.js";
import { getCourse, getLab, checkLab, runSeed } from "./labs.js";

function json(data, status = 200) {
  return new Response(JSON.stringify(data, null, 2), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
  });
}

// Setup check: write one record to Atlas, read it back, report the timing.
async function health(env) {
  const started = Date.now();
  try {
    const result = await withDb(env, async (db) => {
      const col = db.collection("healthchecks");
      await col.updateOne(
        { _id: "worker-ping" },
        { $set: { lastPing: new Date() }, $inc: { count: 1 } },
        { upsert: true },
      );
      return await col.findOne({ _id: "worker-ping" });
    });
    return json({
      ok: true,
      wrote: true,
      read: true,
      pingCount: result.count,
      lastPing: result.lastPing,
      googleSignInConfigured: Boolean(env.GOOGLE_CLIENT_ID && env.GOOGLE_CLIENT_SECRET),
      ms: Date.now() - started,
    });
  } catch (err) {
    return json({ ok: false, error: safeError(err), ms: Date.now() - started });
  }
}

// Who is signed in, and which course versions they can open.
async function me(request, env) {
  if (!readCookie(request, "sid")) return json({ signedIn: false });
  try {
    const user = await withDb(env, (db) => userFromSession(db, request));
    if (!user) return json({ signedIn: false });
    return json({
      signedIn: true,
      email: user.email,
      name: user.name,
      access: Array.isArray(user.access) ? user.access : [],
      admin: Boolean(user.admin),
    });
  } catch (err) {
    return json({ signedIn: false, error: safeError(err) }, 500);
  }
}

// Runs fn(db, user) for a signed-in user and turns its { status, body } into a response.
async function signedIn(request, env, fn) {
  if (!readCookie(request, "sid")) return json({ error: "Please sign in." }, 401);
  try {
    const out = await withDb(env, async (db) => {
      const user = await userFromSession(db, request);
      if (!user) return { status: 401, body: { error: "Please sign in." } };
      return await fn(db, user);
    });
    return json(out.body, out.status);
  } catch (err) {
    return json({ error: safeError(err) }, 500);
  }
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const path = url.pathname;
    if (path === "/api/health") return health(env);
    if (path === "/api/me") return me(request, env);
    if (path === "/api/course" && request.method === "GET") {
      return signedIn(request, env, (db, user) => getCourse(db, user, url.searchParams.get("id")));
    }
    if (path === "/api/lab" && request.method === "GET") {
      return signedIn(request, env, (db, user) => getLab(db, user, url.searchParams.get("id")));
    }
    if (path === "/api/lab/check" && request.method === "POST") {
      const body = await request.json().catch(() => null);
      if (!body) return json({ error: "Bad request." }, 400);
      return signedIn(request, env, (db, user) => checkLab(db, user, body));
    }
    if (path === "/api/admin/seed") {
      return signedIn(request, env, (db, user) => runSeed(db, user, url.searchParams.get("replace") === "1"));
    }
    if (path === "/auth/login") return login(request, env);
    if (path === "/auth/callback") return callback(request, env);
    if (path === "/auth/logout") return logout(request, env);
    if (path.startsWith("/api/") || path.startsWith("/auth/")) {
      return json({ ok: false, error: "Not found" }, 404);
    }
    return env.ASSETS.fetch(request);
  },
};
