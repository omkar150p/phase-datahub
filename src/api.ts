import Fastify, { type FastifyReply } from "fastify";
import type { Pool, PoolClient } from "pg";
import { transaction } from "./database.js";
import { errorFields, type Log } from "./log.js";
import { readViewIntegrity } from "./observation-tools.js";
import { MAX_UINT64, PHASE_CHAIN_ID, PHASE_GENESIS, type ConsensusView } from "./phase-rpc.js";

interface ApiSource {
  id: number;
  highViewId: string | null;
  lastSuccessfulPollAt: Date | null;
  retentionFloorViewId: string | null;
  retentionFloorObservedAt: Date | null;
}

interface ViewGap {
  state: "candidate_sequence_gap" | "unrecoverable_from_source";
  firstViewId: string;
  lastViewId: string;
  detectedAt: Date;
  evidenceResponseId: string;
}

interface ViewRow {
  record: ConsensusView;
  rpcMethod: string;
  firstObservedAt: Date;
  lastObservedAt: Date;
  lastUpdatedAt: Date;
  ingestedAt: Date;
  firstResponseId: string;
  currentResponseId: string;
}

interface ListedView extends ViewRow {
  viewId: string;
}

interface DetailedView extends ViewRow {
  currentResponseIndex: number | null;
}

const METADATA_LIMIT = 20;
const INTEGRITY_EVIDENCE_LIMIT = 5;
const viewPath = "/v1/consensus/views";
const viewFields = `v.normalized_record AS record, r.method AS "rpcMethod",
  v.first_observed_at AS "firstObservedAt", v.last_observed_at AS "lastObservedAt",
  v.last_updated_at AS "lastUpdatedAt", v.ingested_at AS "ingestedAt",
  v.first_response_id AS "firstResponseId", v.current_response_id AS "currentResponseId"`;
const viewSource = `FROM consensus_views v
  JOIN rpc_responses r ON r.source_id = v.source_id AND r.id = v.current_response_id
  WHERE v.source_id = $1`;
const activeGaps = `SELECT state, first_view_id AS "firstViewId", last_view_id AS "lastViewId",
  detected_at AS "detectedAt", evidence_response_id AS "evidenceResponseId"
  FROM view_gaps WHERE source_id = $1 AND superseded_at IS NULL`;

export const historicalQueries = {
  list: `SELECT v.view_id AS "viewId", ${viewFields} ${viewSource} ORDER BY v.view_id DESC LIMIT $2`,
  before: `SELECT v.view_id AS "viewId", ${viewFields} ${viewSource}
    AND v.view_id < $2::numeric ORDER BY v.view_id DESC LIMIT $3`,
  detail: `SELECT ${viewFields}, v.current_response_index AS "currentResponseIndex"
    ${viewSource} AND v.view_id = $2::numeric`,
  gap: `${activeGaps} AND first_view_id <= $2::numeric AND last_view_id >= $2::numeric
    ORDER BY first_view_id DESC, id DESC LIMIT 1`,
};

function isViewId(value: unknown): value is string {
  return typeof value === "string" && /^(0|[1-9][0-9]{0,19})$/.test(value) && BigInt(value) <= MAX_UINT64;
}

async function readArchiveContext(client: PoolClient, endpoint: string) {
  const sources = await client.query<ApiSource>(
    `SELECT s.id, c.high_view_id AS "highViewId", c.last_success_at AS "lastSuccessfulPollAt",
      c.retention_floor_view_id AS "retentionFloorViewId", r.observed_at AS "retentionFloorObservedAt"
     FROM sources s LEFT JOIN collector_checkpoints c ON c.source_id = s.id
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
    knownViewGaps: [] as ViewGap[],
    hasMoreViewGaps: false,
    collectorObservationGaps: [] as unknown[],
    hasMoreCollectorObservationGaps: false,
  };
  const blockHeads = { latest: null as unknown, finalized: null as unknown };
  if (!source) return { id: null, source: provenance, blockHeads, coverage };

  const first = await client.query<{ view_id: string }>(
    "SELECT view_id FROM consensus_views WHERE source_id = $1 ORDER BY view_id LIMIT 1", [source.id],
  );
  coverage.firstObservedViewId = first.rows[0]?.view_id ?? null;

  const gaps = await client.query<ViewGap>(
    `${activeGaps} ORDER BY first_view_id DESC LIMIT $2`,
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
  return { id: source.id, source: provenance, blockHeads, coverage };
}

async function readIntegritySummary(client: PoolClient, sourceId: number, viewId: string) {
  const { status, findings, scannedOccurrences, coverage } = await readViewIntegrity(client, sourceId, viewId);
  const evidence = new Map<string, (typeof findings)[number]["evidence"][number]>();
  const prioritized = [
    ...findings.filter((finding) => finding.severity === "unresolved"),
    ...findings.filter((finding) => finding.severity !== "unresolved"),
  ];
  for (const finding of prioritized) {
    for (const ref of finding.evidence) {
      if (evidence.size === INTEGRITY_EVIDENCE_LIMIT) break;
      evidence.set(ref.responseId + ":" + ref.responseIndex, ref);
    }
  }
  return { status, findingTypes: findings.map(({ kind }) => kind), scannedOccurrences, coverage,
    evidence: [...evidence.values()] };
}

export function buildApi(pool: Pool, endpoint: string, log: Log) {
  const url = new URL(endpoint);
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.search || url.hash) {
    throw new Error("Use an HTTP(S) RPC endpoint without embedded credentials, query, or fragment");
  }
  const api = Fastify({
    logger: false,
    frameworkErrors(error, request, reply: FastifyReply) {
      const path = request.url.split("?", 1)[0]!;
      if (request.method === "GET" && path.startsWith(viewPath + "/") &&
          !path.slice(viewPath.length + 1).includes("/") &&
          (error.code === "FST_ERR_BAD_URL" || error.code === "FST_ERR_MAX_PARAM_LENGTH")) {
        return reply.code(400).send({ error: "invalid_view_id" });
      }
      return reply.send(error);
    },
  });

  api.get<{ Querystring: { limit?: unknown; beforeViewId?: unknown } }>(viewPath, async (request, reply) => {
    const rawLimit = request.query.limit;
    const limit = rawLimit === undefined ? 20
      : typeof rawLimit === "string" && /^[1-9]\d{0,2}$/.test(rawLimit) ? Number(rawLimit) : 0;
    if (limit < 1 || limit > 100) {
      return reply.code(400).send({ error: "limit must be an integer from 1 to 100" });
    }
    const beforeViewId = request.query.beforeViewId ?? null;
    if (beforeViewId !== null && !isViewId(beforeViewId)) {
      return reply.code(400).send({ error: "invalid_before_view_id" });
    }

    return transaction(pool, async (client) => {
      const { rows: [clock] } = await client.query<{ asOf: Date }>('SELECT transaction_timestamp() AS "asOf"');
      const { id, ...context } = await readArchiveContext(client, endpoint);
      const rows = id === null ? [] : beforeViewId === null
        ? (await client.query<ListedView>(historicalQueries.list, [id, limit + 1])).rows
        : (await client.query<ListedView>(historicalQueries.before, [id, beforeViewId, limit + 1])).rows;
      const views = rows.slice(0, limit).map(({ viewId, ...view }) => view);
      const hasMore = rows.length > limit;
      return { ...context, views, page: {
        limit, beforeViewId, nextBeforeViewId: hasMore ? rows[limit - 1]!.viewId : null,
        hasMore, asOf: clock!.asOf,
      } };
    }, "read");
  });

  api.get<{ Params: { viewId: string } }>(viewPath + "/:viewId", async (request, reply) => {
    const { viewId } = request.params;
    if (!isViewId(viewId)) return reply.code(400).send({ error: "invalid_view_id" });

    const result = await transaction(pool, async (client) => {
      const { id, source, blockHeads, coverage } = await readArchiveContext(client, endpoint);
      const missing = { error: "view_not_found", viewId, source, coverage };
      if (id === null) return { found: false, body: { ...missing, lookupState: "source_unregistered" } };

      const { rows: [view] } = await client.query<DetailedView>(historicalQueries.detail, [id, viewId]);
      if (view) {
        const integrity = await readIntegritySummary(client, id, viewId);
        return { found: true, body: { view, source, blockHeads, coverage, integrity } };
      }
      const { rows: [gap] } = await client.query<ViewGap>(historicalQueries.gap, [id, viewId]);
      if (gap) return { found: false, body: { ...missing, lookupState: gap.state, gap } };

      const { firstObservedViewId, highObservedViewId } = coverage;
      const outside = firstObservedViewId !== null && highObservedViewId !== null &&
        (BigInt(viewId) < BigInt(firstObservedViewId) || BigInt(viewId) > BigInt(highObservedViewId));
      return { found: false, body: { ...missing, lookupState: outside ? "outside_observed_range" : "unobserved" } };
    }, "read");
    return reply.code(result.found ? 200 : 404).send(result.body);
  });

  api.setErrorHandler((error, request, reply) => {
    log("error", "api_request_failed", { requestId: request.id, ...errorFields(error) });
    void reply.status(500).send({ error: "Could not read Phase DataHub" });
  });
  return api;
}
