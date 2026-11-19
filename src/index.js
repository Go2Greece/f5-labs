import { withDb, safeError } from "./db.js";
import { login, callback, logout, userFromSession, readCookie } from "./auth.js";

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
    return json({ ok: false, error: safeError(err), ms: Date.now() - started }, 500);
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
    });
  } catch (err) {
    return json({ signedIn: false, error: safeError(err) }, 500);
  }
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const path = url.pathname;
    if (path === "/api/health") return health(env);
    if (path === "/api/me") return me(request, env);
    if (path === "/auth/login") return login(request, env);
    if (path === "/auth/callback") return callback(request, env);
    if (path === "/auth/logout") return logout(request, env);
    if (path.startsWith("/api/") || path.startsWith("/auth/")) {
      return json({ ok: false, error: "Not found" }, 404);
    }
    return env.ASSETS.fetch(request);
  },
};
