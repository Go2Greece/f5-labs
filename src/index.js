import { withDb, safeError } from "./db.js";

function json(data, status = 200) {
  return new Response(JSON.stringify(data, null, 2), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
  });
}

// Step 1 proof: write one record to Atlas, read it back, report the timing.
async function health(env) {
  const started = Date.now();
  try {
    const result = await withDb(env, async (db) => {
      const col = db.collection("healthchecks");
      const now = new Date();
      await col.updateOne(
        { _id: "worker-ping" },
        { $set: { lastPing: now }, $inc: { count: 1 } },
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
      ms: Date.now() - started,
    });
  } catch (err) {
    return json({ ok: false, error: safeError(err), ms: Date.now() - started }, 500);
  }
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname === "/api/health") return health(env);
    if (url.pathname.startsWith("/api/") || url.pathname.startsWith("/auth/")) {
      return json({ ok: false, error: "Not found" }, 404);
    }
    return env.ASSETS.fetch(request);
  },
};
