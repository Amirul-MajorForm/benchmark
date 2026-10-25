import { readFileSync } from "node:fs";
import path from "node:path";
import { Pool } from "pg";

declare global {
  // Reuse one pool across Next.js hot reloads.
  var __benchmarksPool: Pool | undefined;
}

export function getPool(): Pool {
  if (!globalThis.__benchmarksPool) {
    const connectionString = process.env.DATABASE_URL;
    if (!connectionString) throw new Error("DATABASE_URL is not set");
    globalThis.__benchmarksPool = new Pool({
      connectionString,
      max: 5,
      ssl: process.env.PGSSLMODE === "require" ? { rejectUnauthorized: false } : undefined,
    });
  }
  return globalThis.__benchmarksPool;
}

export async function closePool(): Promise<void> {
  if (globalThis.__benchmarksPool) {
    await globalThis.__benchmarksPool.end();
    globalThis.__benchmarksPool = undefined;
  }
}

/** Create tables (idempotent) and seed the account mapping without overwriting edits. */
export async function migrate(): Promise<void> {
  const dir = path.join(process.cwd(), "db");
  const pool = getPool();
  await pool.query(readFileSync(path.join(dir, "schema.sql"), "utf8"));
  await pool.query(readFileSync(path.join(dir, "seed-accounts.sql"), "utf8"));
}
