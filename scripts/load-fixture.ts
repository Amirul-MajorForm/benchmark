/** Load the recorded Q2 2025 Two Minutes data into DATABASE_URL through the real sync code (no API key needed). */
import { closePool, migrate } from "../lib/db";
import { runSync } from "../lib/sync";
import { fixtureQuery } from "../tests/fixture-source";

async function main() {
  await migrate();
  const { query } = fixtureQuery();
  const result = await runSync({ today: "2025-06-30", full: true, query });
  if (result.status !== "success") process.exitCode = 1;
}

main().finally(closePool);
