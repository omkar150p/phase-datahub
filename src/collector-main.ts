import { Collector } from "./collector.js";
import { collectorConfig, requireEnv } from "./config.js";
import { ArchiveDatabase, createPool } from "./database.js";
import { errorFields, logJson } from "./log.js";
import { PhaseRpc } from "./phase-rpc.js";

async function main() {
  const stop = new AbortController();
  const finish = () => stop.abort();
  process.once("SIGINT", finish);
  process.once("SIGTERM", finish);
  if (process.platform === "win32") process.once("SIGBREAK", finish);

  const settings = collectorConfig();
  const pool = createPool(requireEnv("DATABASE_URL"));
  pool.on("error", (error) => logJson("error", "postgres_idle_connection_error", errorFields(error)));
  try {
    const db = new ArchiveDatabase(pool);
    const rpc = new PhaseRpc(settings.endpoint, settings.rpc, logJson);
    const identity = await rpc.getIdentity(stop.signal);
    stop.signal.throwIfAborted();
    const sourceId = await db.registerSource(rpc.endpoint, identity);
    const collector = new Collector(sourceId, rpc, db, settings.collector, logJson);
    logJson("info", "collector_started", { sourceId, endpoint: rpc.endpoint, chainId: identity.chainId });
    await collector.run(stop.signal);
  } catch (error) {
    if (!stop.signal.aborted) throw error;
  } finally {
    await pool.end();
    logJson("info", "collector_stopped");
  }
}

main().catch((error: unknown) => {
  logJson("error", "collector_fatal", errorFields(error));
  process.exitCode = 1;
});
