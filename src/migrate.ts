import { requireEnv } from "./config.js";
import { createPool, migrate } from "./database.js";
import { errorFields, logJson } from "./log.js";

async function main() {
  const pool = createPool(requireEnv("DATABASE_URL"));
  try {
    await migrate(pool);
    logJson("info", "database_schema_ready");
  } finally {
    await pool.end();
  }
}

main().catch((error: unknown) => {
  logJson("error", "database_migration_failed", errorFields(error));
  process.exitCode = 1;
});
