// Google sign-in. Students register themselves by signing in; the first sign-in
// creates their record in Atlas with an empty access list. Access is then granted
// by hand in Atlas by adding a course version (for example "owasp-v1") to "access".
import { withDb, safeError } from "./db.js";

const SESSION_COOKIE = "sid";
const STATE_COOKIE = "oauth_state";
const SESSION_DAYS = 30;

function randomToken(bytes = 32) {
  const a = new Uint8Array(bytes);
  crypto.getRandomValues(a);
  return [...a].map((b) => b.toString(16).padStart(2, "0")).join("");
}

async function sha256(text) {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export function readCookie(request, name) {
  const header = request.headers.get("cookie") || "";
  for (const part of header.split(";")) {
    const i = part.indexOf("=");
    if (i > -1 && part.slice(0, i).trim() === name) return decodeURIComponent(part.slice(i + 1).trim());
  }
  return null;
}

function cookie(name, value, maxAgeSeconds) {
  return `${name}=${encodeURIComponent(value)}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${maxAgeSeconds}`;
}

function redirect(location, cookies = []) {
  const headers = new Headers({ location, "cache-control": "no-store" });
  for (const c of cookies) headers.append("set-cookie", c);
  return new Response(null, { status: 302, headers });
}

function errorPage(message, status = 400) {
  const safe = String(message).replace(/[<>&]/g, (c) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;" }[c]));
  return new Response(
    `<!DOCTYPE html><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Sign-in problem</title>
<body style="font-family:Archivo,"Helvetica Neue",Helvetica,Arial,sans-serif;max-width:520px;margin:12vh auto;padding:24px;color:#0a0e1c">
<h1 style="font-size:20px">Sign-in did not complete</h1><p>${safe}</p><p><a href="/">Back to the front page</a></p></body>`,
    { status, headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" } },
  );
}

function decodeJwtPayload(jwt) {
  const part = jwt.split(".")[1];
  const b64 = part.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(part.length / 4) * 4, "=");
  const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
  return JSON.parse(new TextDecoder().decode(bytes));
}

function googleConfigured(env) {
  return Boolean(env.GOOGLE_CLIENT_ID && env.GOOGLE_CLIENT_SECRET);
}

// GET /auth/login
export function login(request, env) {
  if (!googleConfigured(env)) {
    return errorPage("Google sign-in is not configured yet (GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET are missing).", 503);
  }
  const url = new URL(request.url);
  const state = randomToken(16);
  const auth = new URL("https://accounts.google.com/o/oauth2/v2/auth");
  auth.searchParams.set("client_id", env.GOOGLE_CLIENT_ID);
  auth.searchParams.set("redirect_uri", `${url.origin}/auth/callback`);
  auth.searchParams.set("response_type", "code");
  auth.searchParams.set("scope", "openid email profile");
  auth.searchParams.set("state", state);
  auth.searchParams.set("prompt", "select_account");
  return redirect(auth.toString(), [cookie(STATE_COOKIE, state, 600)]);
}

// GET /auth/callback
export async function callback(request, env) {
  if (!googleConfigured(env)) return errorPage("Google sign-in is not configured yet.", 503);
  const url = new URL(request.url);
  if (url.searchParams.get("error")) return errorPage("Google reported: " + url.searchParams.get("error"));
  const code = url.searchParams.get("code");
  const state = url.searchParams.get("state");
  const expected = readCookie(request, STATE_COOKIE);
  if (!code || !state || !expected || state !== expected) {
    return errorPage("The sign-in request expired or did not match. Please try again.");
  }

  // Exchange the code for tokens, server to server.
  const tokenRes = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      code,
      client_id: env.GOOGLE_CLIENT_ID,
      client_secret: env.GOOGLE_CLIENT_SECRET,
      redirect_uri: `${url.origin}/auth/callback`,
      grant_type: "authorization_code",
    }),
  });
  const tokens = await tokenRes.json().catch(() => ({}));
  if (!tokenRes.ok || !tokens.id_token) {
    return errorPage("Google did not accept the sign-in (" + (tokens.error || tokenRes.status) + ").");
  }

  // The ID token came straight from Google over TLS, so its claims can be trusted.
  const claims = decodeJwtPayload(tokens.id_token);
  const issuerOk = claims.iss === "https://accounts.google.com" || claims.iss === "accounts.google.com";
  if (!issuerOk || claims.aud !== env.GOOGLE_CLIENT_ID || !claims.sub || !claims.email) {
    return errorPage("Google returned an unexpected identity.");
  }
  if (claims.email_verified === false) return errorPage("That Google account's email address is not verified.");

  const email = String(claims.email).toLowerCase();
  const now = new Date();
  const sessionToken = randomToken(32);
  const sessionHash = await sha256(sessionToken);
  const expires = new Date(now.getTime() + SESSION_DAYS * 86400 * 1000);

  try {
    await withDb(env, async (db) => {
      const users = db.collection("users");
      const sessions = db.collection("sessions");
      await users.createIndex({ googleId: 1 }, { unique: true });
      await users.createIndex({ email: 1 });
      await sessions.createIndex({ expires: 1 }, { expireAfterSeconds: 0 });
      await users.updateOne(
        { googleId: claims.sub },
        {
          $set: { email, name: claims.name || email, picture: claims.picture || null, lastLogin: now },
          $setOnInsert: { registered: now, access: [] },
        },
        { upsert: true },
      );
      await sessions.insertOne({ _id: sessionHash, googleId: claims.sub, email, created: now, expires });
    });
  } catch (err) {
    return errorPage("Could not save your sign-in to the database: " + safeError(err), 500);
  }

  return redirect("/", [cookie(SESSION_COOKIE, sessionToken, SESSION_DAYS * 86400), cookie(STATE_COOKIE, "", 0)]);
}

// Loads the signed-in user inside an existing db connection. Returns null when signed out.
export async function userFromSession(db, request) {
  const token = readCookie(request, SESSION_COOKIE);
  if (!token) return null;
  const session = await db.collection("sessions").findOne({ _id: await sha256(token) });
  if (!session || session.expires < new Date()) return null;
  return await db.collection("users").findOne({ googleId: session.googleId });
}

// GET /auth/logout
export async function logout(request, env) {
  const token = readCookie(request, SESSION_COOKIE);
  if (token) {
    try {
      const hash = await sha256(token);
      await withDb(env, (db) => db.collection("sessions").deleteOne({ _id: hash }));
    } catch (_) {
      // Clearing the cookie below still signs the browser out.
    }
  }
  return redirect("/", [cookie(SESSION_COOKIE, "", 0)]);
}
