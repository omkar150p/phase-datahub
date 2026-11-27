import { requireEnv } from "./config.js";
import { createPool } from "./database.js";
import { errorFields, logJson } from "./log.js";
import { backfillObservations, inspectViewObservations } from "./observation-tools.js";

async function main() {
  const [command, first, second, ...rest] = process.argv.slice(2);
  const pool = createPool(requireEnv("DATABASE_URL"));
  try {
    if (command === "backfill" && second === undefined && (!first || /^[1-9]\d{0,2}$/.test(first))) {
      console.log(JSON.stringify(await backfillObservations(pool, first ? Number(first) : 25)));
    } else if (command === "inspect" && first && /^[1-9]\d{0,9}$/.test(first) && second && !rest.length) {
      console.log(JSON.stringify(await inspectViewObservations(pool, Number(first), second), null, 2));
    } else {
      throw new Error("Use db:backfill-observations -- [limit] or db:inspect-observations -- <source-id> <view-id>");
    }
  } finally {
    await pool.end();
  }
}

main().catch((error: unknown) => {
  logJson("error", "observation_command_failed", errorFields(error));
  process.exitCode = 1;
});
