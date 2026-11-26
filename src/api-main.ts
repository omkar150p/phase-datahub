import { buildApi } from "./api.js";
import { DEFAULT_ENDPOINT, intEnv, requireEnv } from "./config.js";
import { createPool } from "./database.js";
import { errorFields, logJson } from "./log.js";

async function main() {
  const endpoint = process.env.PHASE_RPC_URL ?? DEFAULT_ENDPOINT;
  const host = process.env.API_HOST ?? "127.0.0.1";
  const port = intEnv("API_PORT", 8787, 1, 65_535);
  const pool = createPool(requireEnv("DATABASE_URL"));
  pool.on("error", (error) => logJson("error", "postgres_idle_connection_error", errorFields(error)));
  try {
    const api = buildApi(pool, endpoint, logJson);
    const address = await api.listen({ host, port });
    logJson("info", "api_started", { address, endpoint });
    await new Promise<void>((resolve) => {
      process.once("SIGINT", resolve);
      process.once("SIGTERM", resolve);
      if (process.platform === "win32") process.once("SIGBREAK", resolve);
    });
    await api.close();
    logJson("info", "api_stopped");
  } finally {
    await pool.end();
  }
}

main().catch((error: unknown) => {
  logJson("error", "api_fatal", errorFields(error));
  process.exitCode = 1;
});
