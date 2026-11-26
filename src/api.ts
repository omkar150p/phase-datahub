import Fastify from "fastify";
import type { Pool } from "pg";
import { transaction } from "./database.js";
import { errorFields, type Log } from "./log.js";
import { PHASE_CHAIN_ID, PHASE_GENESIS } from "./phase-rpc.js";

interface ApiSource {
  id: number;
  highViewId: string | null;
  lastSuccessfulPollAt: Date | null;
  retentionFloorViewId: string | null;
  retentionFloorObservedAt: Date | null;
}

const METADATA_LIMIT = 20;

export function buildApi(pool: Pool, endpoint: string, log: Log) {
  const url = new URL(endpoint);
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.search || url.hash) {
    throw new Error("Use an HTTP(S) RPC endpoint without embedded credentials, query, or fragment");
  }
  const api = Fastify({ logger: false });

  api.get<{ Querystring: { limit?: unknown } }>("/v1/consensus/views", async (request, reply) => {
    const rawLimit = request.query.limit;
    const limit = rawLimit === undefined ? 20
      : typeof rawLimit === "string" && /^[1-9]\d{0,2}$/.test(rawLimit) ? Number(rawLimit) : 0;
    if (limit < 1 || limit > 100) {
      return reply.code(400).send({ error: "limit must be an integer from 1 to 100" });
    }

    return transaction(pool, async (client) => {
      const sources = await client.query<ApiSource>(
        `SELECT s.id, c.high_view_id AS "highViewId", c.last_success_at AS "lastSuccessfulPollAt",
          c.retention_floor_view_id AS "retentionFloorViewId", r.observed_at AS "retentionFloorObservedAt"
         FROM sources s JOIN collector_checkpoints c ON c.source_id = s.id
         LEFT JOIN rpc_responses r ON r.source_id = s.id AND r.id = c.retention_floor_response_id
         WHERE s.endpoint = $1 AND s.chain_id = $2 AND s.genesis_hash = $3`,
        [endpoint, PHASE_CHAIN_ID, PHASE_GENESIS],
      );
      const source = sources.rows[0];
      const provenance = {
        endpoint, chainId: PHASE_CHAIN_ID, genesisHash: PHASE_GENESIS,
        status: "source_observed", registered: source !== undefined,
      };
      const coverage = {
        firstObservedViewId: null as string | null,
        highObservedViewId: source?.highViewId ?? null,
        lastSuccessfulPollAt: source?.lastSuccessfulPollAt ?? null,
        retentionFloorViewId: source?.retentionFloorViewId ?? null,
        retentionFloorObservedAt: source?.retentionFloorObservedAt ?? null,
        knownViewGaps: [] as unknown[],
        hasMoreViewGaps: false,
        collectorObservationGaps: [] as unknown[],
        hasMoreCollectorObservationGaps: false,
      };
      const blockHeads = { latest: null as unknown, finalized: null as unknown };
      if (!source) return { source: provenance, blockHeads, coverage, views: [] };

      const result = await client.query(
        `SELECT v.normalized_record AS record, r.method AS "rpcMethod",
          v.first_observed_at AS "firstObservedAt", v.last_observed_at AS "lastObservedAt",
          v.last_updated_at AS "lastUpdatedAt", v.ingested_at AS "ingestedAt",
          v.first_response_id AS "firstResponseId", v.current_response_id AS "currentResponseId"
         FROM consensus_views v JOIN rpc_responses r ON r.source_id = v.source_id AND r.id = v.current_response_id
         WHERE v.source_id = $1 ORDER BY v.view_id DESC LIMIT $2`,
        [source.id, limit],
      );
      const first = await client.query<{ view_id: string }>(
        "SELECT view_id FROM consensus_views WHERE source_id = $1 ORDER BY view_id LIMIT 1", [source.id],
      );
      coverage.firstObservedViewId = first.rows[0]?.view_id ?? null;

      const gaps = await client.query(
        `SELECT state, first_view_id AS "firstViewId", last_view_id AS "lastViewId",
          detected_at AS "detectedAt", evidence_response_id AS "evidenceResponseId"
         FROM view_gaps WHERE source_id = $1 AND superseded_at IS NULL
         ORDER BY first_view_id DESC LIMIT $2`,
        [source.id, METADATA_LIMIT + 1],
      );
      coverage.knownViewGaps = gaps.rows.slice(0, METADATA_LIMIT);
      coverage.hasMoreViewGaps = gaps.rows.length > METADATA_LIMIT;

      const observationGaps = await client.query(
        `SELECT after_success_at AS "afterSuccessAt", resumed_at AS "resumedAt",
          evidence_response_id AS "evidenceResponseId"
         FROM collector_observation_gaps WHERE source_id = $1 ORDER BY resumed_at DESC LIMIT $2`,
        [source.id, METADATA_LIMIT + 1],
      );
      coverage.collectorObservationGaps = observationGaps.rows.slice(0, METADATA_LIMIT);
      coverage.hasMoreCollectorObservationGaps = observationGaps.rows.length > METADATA_LIMIT;

      const heads = await client.query<{ tag: "latest" | "finalized"; observation: unknown }>(
        `SELECT DISTINCT ON (h.tag) h.tag,
          jsonb_build_object('height', h.height::text, 'hash', h.hash,
           'blockTimestampSecs', h.block_timestamp_secs::text, 'observedAt', r.observed_at,
           'rpcMethod', r.method, 'responseId', r.id::text) AS observation
         FROM block_head_observations h JOIN rpc_responses r ON r.source_id = h.source_id AND r.id = h.response_id
         WHERE h.source_id = $1 ORDER BY h.tag, h.response_id DESC`,
        [source.id],
      );
      for (const head of heads.rows) blockHeads[head.tag] = head.observation;
      return { source: provenance, blockHeads, coverage, views: result.rows };
    }, "read");
  });

  api.setErrorHandler((error, request, reply) => {
    log("error", "api_request_failed", { requestId: request.id, ...errorFields(error) });
    void reply.status(500).send({ error: "Could not read Phase DataHub" });
  });
  return api;
}
