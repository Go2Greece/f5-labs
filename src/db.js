// All MongoDB Atlas access lives here, server side only.
// The connection string is the Worker secret MONGODB_URI and never reaches the browser.
import { MongoClient } from "mongodb";

export const DB_NAME = "f5labs";

// Opens a connection, runs fn(db), and always closes the connection.
export async function withDb(env, fn) {
  if (!env.MONGODB_URI) {
    throw new Error("MONGODB_URI secret is not set on the Worker");
  }
  const client = new MongoClient(env.MONGODB_URI, {
    maxPoolSize: 1,
    minPoolSize: 0,
    serverSelectionTimeoutMS: 8000,
  });
  try {
    await client.connect();
    return await fn(client.db(DB_NAME));
  } finally {
    await client.close().catch(() => {});
  }
}

// Never let a connection string or password leak into an error message.
export function safeError(err) {
  const msg = String((err && err.message) || err);
  return msg.replace(/mongodb(\+srv)?:\/\/[^\s"']+/gi, "mongodb://[hidden]");
}
