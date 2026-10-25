import { closePool, migrate } from "../lib/db";
import { runSync } from "../lib/sync";

// npm run sync            -> backfill missing half-years + re-pull the restatement window
// npm run sync -- --full  -> re-pull everything from 2025-01-01
const full = process.argv.includes("--full");

async function main() {
  await migrate();
  const result = await runSync({ full });
  if (result.status === "failed") process.exitCode = 1;
}

main()
  .catch((err) => {
    console.error("sync crashed:", err);
    process.exitCode = 1;
  })
  .finally(closePool);
