export const DEFAULT_ENDPOINT = "https://rpc-main.phase.xyz";

export function requireEnv(key: string): string {
  const value = process.env[key]?.trim();
  if (!value) throw new Error("Set " + key + " before starting Phase DataHub");
  return value;
}

export function intEnv(key: string, fallback: number, min: number, max: number): number {
  const raw = process.env[key];
  if (raw === undefined) return fallback;
  const value = /^\d+$/.test(raw) ? Number(raw) : NaN;
  if (!Number.isInteger(value) || value < min || value > max) {
    throw new Error(key + " must be an integer between " + min + " and " + max);
  }
  return value;
}

export function collectorConfig() {
  return {
    endpoint: process.env.PHASE_RPC_URL ?? DEFAULT_ENDPOINT,
    rpc: {
      concurrency: intEnv("RPC_CONCURRENCY", 1, 1, 8),
      timeoutMs: intEnv("RPC_TIMEOUT_MS", 5_000, 100, 60_000),
      retries: intEnv("RPC_RETRIES", 3, 0, 8),
      backoffBaseMs: intEnv("RPC_BACKOFF_BASE_MS", 500, 10, 60_000),
      backoffMaxMs: intEnv("RPC_BACKOFF_MAX_MS", 12_000, 100, 180_000),
    },
    collector: {
      batchSize: intEnv("COLLECTOR_BATCH_SIZE", 250, 1, 10_000),
      overlapViews: intEnv("COLLECTOR_OVERLAP_VIEWS", 8, 0, 9_999),
      pollIntervalMs: intEnv("COLLECTOR_POLL_MS", 5_000, 250, 600_000),
      catchupIntervalMs: intEnv("COLLECTOR_CATCHUP_MS", 750, 250, 600_000),
      observationGapMs: intEnv("COLLECTOR_OBSERVATION_GAP_MS", 60_000, 1_000, 86_400_000),
      retentionProbeIntervalMs: intEnv("COLLECTOR_RETENTION_PROBE_MS", 900_000, 1_000, 86_400_000),
      headIntervalMs: intEnv("COLLECTOR_HEAD_MS", 30_000, 1_000, 600_000),
    },
  };
}
