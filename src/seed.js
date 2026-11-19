// Seed data. The JSON files in /seed are the authoring copies; Atlas is what the engine reads.
// Seeding only inserts records that are missing, so a published version is never changed.
import course1 from "../seed/owasp-v1.course.json";
import lab1 from "../seed/owasp-v1.m01.lab01.lab.json";

export const SEED_COURSES = [course1];
export const SEED_LABS = [lab1];

export async function seed(db, replace) {
  const report = { courses: [], labs: [] };
  for (const [name, docs] of [["courses", SEED_COURSES], ["labs", SEED_LABS]]) {
    const col = db.collection(name);
    for (const doc of docs) {
      const exists = await col.findOne({ _id: doc._id }, { projection: { _id: 1 } });
      if (!exists) {
        await col.insertOne({ ...doc, seededAt: new Date() });
        report[name].push(doc._id + ": inserted");
      } else if (replace) {
        await col.replaceOne({ _id: doc._id }, { ...doc, seededAt: new Date() });
        report[name].push(doc._id + ": replaced");
      } else {
        report[name].push(doc._id + ": already there, left unchanged");
      }
    }
  }
  return report;
}
