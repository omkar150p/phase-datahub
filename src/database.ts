import { Pool, type PoolClient } from "pg";
import { type Head, type HeadTag, type RpcEvidence, type RpcResult, type ViewPage } from "./phase-rpc.js";
import { indexViewResponse } from "./observation-index.js";
import { applyMigrations } from "./schema-migrations.js";
import { classifyRanges, newSequenceGaps, removeObserved, type GapState, type Range } from "./gaps.js";

export interface Checkpoint {
  revision: string;
  highViewId: string | null;
  lastSuccessAt: Date | null;
  lastRetentionProbeAt: Date | null;
}

interface ArchivedGap {
  id: string;
  first_view_id: string;
  last_view_id: string;
  state: GapState;
  evidence_response_id: string;
}

type ResponsePurpose =
  | "chain_identity" | "view_page" | "retention_probe" | "latest_head" | "finalized_head" | "superseded_poll";

interface FloorEvidence {
  view: bigint;
  responseId: string;
  observedAt: Date;
}

export function createPool(connectionString: string, options?: string): Pool {
  return new Pool({
    connectionString, options, connectionTimeoutMillis: 5_000, statement_timeout: 20_000,
    idle_in_transaction_session_timeout: 25_000,
  });
}

export async function transaction<T>(
  pool: Pool, work: (client: PoolClient) => Promise<T>, mode: "write" | "read" = "write",
): Promise<T> {
  const client = await pool.connect();
  let discard = false;
  try {
    await client.query(mode === "read" ? "BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY" : "BEGIN");
    const result = await work(client);
    await client.query("COMMIT");
    return result;
  } catch (error) {
    try {
      await client.query("ROLLBACK");
    } catch {
      discard = true;
    }
    throw error;
  } finally {
    client.release(discard);
  }
}

export async function migrate(pool: Pool): Promise<void> {
  await transaction(pool, applyMigrations);
}

async function archive(
  client: PoolClient, sourceId: number, purpose: ResponsePurpose, evidence: RpcEvidence,
): Promise<string> {
  const out = await client.query<{ id: string }>(
    "INSERT INTO rpc_responses (source_id, method, purpose, request_body, response_body, observed_at) " +
    "VALUES ($1, $2, $3, $4, $5, $6) RETURNING id",
    [sourceId, evidence.method, purpose, evidence.requestBody, evidence.rawResponse, evidence.observedAt],
  );
  return out.rows[0]!.id;
}

async function archiveViewPage(
  client: PoolClient, sourceId: number, purpose: ResponsePurpose, page: ViewPage,
): Promise<string> {
  const responseId = await archive(client, sourceId, purpose, page);
  await indexViewResponse(client, sourceId, responseId, page.occurrences);
  return responseId;
}

async function addGap(
  client: PoolClient,
  sourceId: number,
  gap: Range & { state: GapState },
  evidenceId: string,
  detectedAt: Date,
  supersedesId: string | null = null,
) {
  await client.query(
    "INSERT INTO view_gaps (source_id, first_view_id, last_view_id, state, detected_at, " +
    "evidence_response_id, supersedes_gap_id) VALUES ($1, $2, $3, $4, $5, $6, $7)",
    [sourceId, gap.first.toString(), gap.last.toString(), gap.state, detectedAt, evidenceId, supersedesId],
  );
}

async function persistViews(
  client: PoolClient, sourceId: number, page: ViewPage, pageId: string,
): Promise<void> {
  if (page.result.length === 0) return;
  const inputs = page.result.map((record) => {
    const responseIndex = page.projectionIndexes.get(record.viewId);
    if (responseIndex === undefined) throw new Error("Missing projected occurrence for view " + record.viewId);
    return { record, responseIndex };
  });
  await client.query(
    `WITH incoming AS (
      SELECT value->'record' AS record, (value->'record'->>'viewId')::numeric AS view_id,
        (value->>'responseIndex')::integer AS response_index
      FROM jsonb_array_elements($2::jsonb)
    ), projection AS (
      SELECT incoming.view_id, incoming.response_index,
        CASE WHEN
          (existing.certificate_status = 'full' AND incoming.record->>'certificateStatus' <> 'full')
          OR (existing.certificate_status = 'tentative' AND incoming.record->>'certificateStatus' = 'none')
          OR (existing.certificate_status = incoming.record->>'certificateStatus'
              AND existing.view_timestamp_secs > (incoming.record->>'viewTimestampSecs')::numeric)
          THEN existing.normalized_record ELSE incoming.record END AS record
      FROM incoming
      LEFT JOIN consensus_views existing ON existing.source_id = $1 AND existing.view_id = incoming.view_id
    )
    INSERT INTO consensus_views (
      source_id, view_id, view_timestamp_secs, block_height, certificate_status, normalized_record,
      first_response_id, current_response_id, current_response_index, first_observed_at, last_observed_at
    )
    SELECT $1, view_id, (record->>'viewTimestampSecs')::numeric, (record->>'blockHeight')::numeric,
      record->>'certificateStatus', record, $3, $3, response_index, $4, $4
    FROM projection
    ON CONFLICT (source_id, view_id) DO UPDATE SET
      view_timestamp_secs = EXCLUDED.view_timestamp_secs,
      block_height = EXCLUDED.block_height,
      certificate_status = EXCLUDED.certificate_status,
      normalized_record = EXCLUDED.normalized_record,
      last_observed_at = GREATEST(consensus_views.last_observed_at, EXCLUDED.last_observed_at),
      current_response_id = CASE WHEN consensus_views.normalized_record IS DISTINCT FROM EXCLUDED.normalized_record
        THEN EXCLUDED.current_response_id ELSE consensus_views.current_response_id END,
      current_response_index = CASE WHEN consensus_views.normalized_record IS DISTINCT FROM EXCLUDED.normalized_record
        THEN EXCLUDED.current_response_index ELSE consensus_views.current_response_index END,
      last_updated_at = CASE WHEN consensus_views.normalized_record IS DISTINCT FROM EXCLUDED.normalized_record
        THEN clock_timestamp() ELSE consensus_views.last_updated_at END`,
    [sourceId, JSON.stringify(inputs), pageId, page.observedAt],
  );
}

async function updateGaps(
  client: PoolClient,
  sourceId: number,
  ids: readonly bigint[],
  checkpointHigh: bigint | null,
  pageId: string,
  observedAt: Date,
  floor?: FloorEvidence,
): Promise<void> {
  const floorView = floor?.view ?? null;
  const existing = await client.query<ArchivedGap>(
    `SELECT id, first_view_id, last_view_id, state, evidence_response_id
     FROM view_gaps
     WHERE source_id = $1 AND superseded_at IS NULL AND (
       (first_view_id <= $2::numeric AND last_view_id >= $3::numeric)
       OR (state = 'candidate_sequence_gap' AND first_view_id < $4::numeric)
     )`,
    [sourceId, ids.at(-1)?.toString() ?? null, ids[0]?.toString() ?? null, floorView?.toString() ?? null],
  );

  for (const previous of existing.rows) {
    const range = { first: BigInt(previous.first_view_id), last: BigInt(previous.last_view_id) };
    const fragments = classifyRanges(removeObserved(range, ids), previous.state, floorView);
    const same = fragments[0];
    if (fragments.length === 1 && same?.first === range.first && same.last === range.last &&
        same.state === previous.state) continue;

    await client.query("UPDATE view_gaps SET superseded_at = clock_timestamp() WHERE id = $1", [previous.id]);
    for (const piece of fragments) {
      const promoted = piece.state !== previous.state && floor;
      await addGap(client, sourceId, piece,
        promoted ? promoted.responseId : previous.evidence_response_id,
        promoted ? promoted.observedAt : observedAt, previous.id);
    }
  }

  for (const gap of classifyRanges(newSequenceGaps(checkpointHigh, ids), "candidate_sequence_gap", floorView)) {
    if (gap.state === "unrecoverable_from_source" && floor) {
      await addGap(client, sourceId, gap, floor.responseId, floor.observedAt);
    } else {
      await addGap(client, sourceId, gap, pageId, observedAt);
    }
  }
}

const CHECKPOINT_QUERY = `SELECT revision, high_view_id AS "highViewId", last_success_at AS "lastSuccessAt",
  last_retention_probe_at AS "lastRetentionProbeAt" FROM collector_checkpoints WHERE source_id = $1`;

export class ArchiveDatabase {
  constructor(readonly pool: Pool) {}

  async registerSource(
    endpoint: string, identity: { chainId: string; genesisHash: string; evidence: RpcEvidence[] },
  ): Promise<number> {
    return transaction(this.pool, async (client) => {
      const result = await client.query<{ id: number }>(
        "INSERT INTO sources (endpoint, chain_id, genesis_hash) VALUES ($1, $2, $3) " +
        "ON CONFLICT (endpoint, chain_id, genesis_hash) DO UPDATE SET endpoint = EXCLUDED.endpoint RETURNING id",
        [endpoint, identity.chainId, identity.genesisHash],
      );
      const sourceId = result.rows[0]!.id;
      await client.query("INSERT INTO collector_checkpoints (source_id) VALUES ($1) ON CONFLICT DO NOTHING", [sourceId]);
      for (const evidence of identity.evidence) await archive(client, sourceId, "chain_identity", evidence);
      return sourceId;
    });
  }

  async checkpoint(sourceId: number): Promise<Checkpoint> {
    const result = await this.pool.query<Checkpoint>(CHECKPOINT_QUERY, [sourceId]);
    const checkpoint = result.rows[0];
    if (!checkpoint) throw new Error("Phase source has no checkpoint");
    return checkpoint;
  }

  async hasCandidateGaps(sourceId: number): Promise<boolean> {
    const result = await this.pool.query<{ pending: boolean }>(
      "SELECT EXISTS(SELECT 1 FROM view_gaps WHERE source_id = $1 AND superseded_at IS NULL " +
      "AND state = 'candidate_sequence_gap') AS pending", [sourceId],
    );
    return result.rows[0]!.pending;
  }

  async commitPoll(
    sourceId: number,
    expectedRevision: string,
    page: ViewPage,
    retention: { page: ViewPage; complete: boolean } | undefined,
    observationGapMs: number,
  ): Promise<{ committed: boolean; highViewId: string | null }> {
    const probe = retention?.page;
    return transaction(this.pool, async (client) => {
      const locked = await client.query<Checkpoint>(CHECKPOINT_QUERY + " FOR UPDATE", [sourceId]);
      const previous = locked.rows[0];
      if (!previous) throw new Error("Phase source has no checkpoint");
      if (previous.revision !== expectedRevision) {
        await archiveViewPage(client, sourceId, "superseded_poll", page);
        if (probe) await archiveViewPage(client, sourceId, "superseded_poll", probe);
        return { committed: false, highViewId: previous.highViewId };
      }

      const pageId = await archiveViewPage(client, sourceId, "view_page", page);
      const probeId = probe && await archiveViewPage(client, sourceId, "retention_probe", probe);
      const earliest = retention?.complete ? probe?.result[0] : undefined;
      const floor = earliest && probe && probeId
        ? { view: BigInt(earliest.viewId), responseId: probeId, observedAt: probe.observedAt }
        : undefined;

      const oldHigh = previous.highViewId === null ? null : BigInt(previous.highViewId);
      const ids = page.result.map(({ viewId }) => BigInt(viewId));
      const newest = ids.at(-1);
      const high = newest !== undefined && (oldHigh === null || newest > oldHigh) ? newest : oldHigh;

      await persistViews(client, sourceId, page, pageId);
      if (probe && probeId && high !== null) {
        const first = await client.query<{ view_id: string }>(
          "SELECT view_id FROM consensus_views WHERE source_id = $1 ORDER BY view_id LIMIT 1", [sourceId],
        );
        const earliest = first.rows[0]?.view_id;
        if (earliest !== undefined) {
          const existingPage = new Set(ids);
          const low = BigInt(earliest);
          const repairs = probe.result.filter(({ viewId }) => {
            const id = BigInt(viewId);
            return id >= low && id <= high && !existingPage.has(id);
          });
          await persistViews(client, sourceId, { ...probe, result: repairs }, probeId);
          ids.push(...repairs.map(({ viewId }) => BigInt(viewId)));
          ids.sort((a, b) => a < b ? -1 : a > b ? 1 : 0);
        }
      }
      await updateGaps(client, sourceId, ids, oldHigh, pageId, page.observedAt, floor);
      if (previous.lastSuccessAt && page.observedAt.getTime() - previous.lastSuccessAt.getTime() > observationGapMs) {
        await client.query(
          "INSERT INTO collector_observation_gaps (source_id, after_success_at, resumed_at, evidence_response_id) " +
          "VALUES ($1, $2, $3, $4)",
          [sourceId, previous.lastSuccessAt, page.observedAt, pageId],
        );
      }

      const highViewId = high?.toString() ?? null;
      await client.query(
        `UPDATE collector_checkpoints SET
          revision = revision + 1, high_view_id = $2, last_success_at = GREATEST(last_success_at, $3::timestamptz),
          last_retention_probe_at = COALESCE($4::timestamptz, last_retention_probe_at),
          retention_floor_view_id = COALESCE($5::numeric, retention_floor_view_id),
          retention_floor_response_id = COALESCE($6::bigint, retention_floor_response_id)
         WHERE source_id = $1`,
        [sourceId, highViewId, page.observedAt, probe?.observedAt ?? null,
          floor?.view.toString() ?? null, floor?.responseId ?? null],
      );
      return { committed: true, highViewId };
    });
  }

  async archiveHead(sourceId: number, tag: HeadTag, response: RpcResult<Head>): Promise<void> {
    await transaction(this.pool, async (client) => {
      const responseId = await archive(client, sourceId, tag === "latest" ? "latest_head" : "finalized_head", response);
      await client.query(
        "INSERT INTO block_head_observations (response_id, source_id, tag, height, hash, block_timestamp_secs) " +
        "VALUES ($1, $2, $3, $4, $5, $6)",
        [responseId, sourceId, tag, response.result.height, response.result.hash, response.result.blockTimestampSecs],
      );
    });
  }
}
