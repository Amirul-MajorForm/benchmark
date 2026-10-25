import { closePool, migrate } from "../lib/db";

migrate()
  .then(() => console.log("migrate: schema and account seed applied"))
  .catch((err) => {
    console.error("migrate failed:", err);
    process.exitCode = 1;
  })
  .finally(closePool);
