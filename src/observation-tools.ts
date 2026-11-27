import type { Pool } from "pg";
import { transaction } from "./database.js";
import { indexViewResponse, recordUnsupportedViewResponse } from "./observation-index.js";
import { compareViewObservations, type Observation } from "./observation-findings.js";
import { decodeArchivedViewOccurrences, MAX_UINT64, RpcError, VIEW_METHOD } from "./phase-rpc.js";

interface ArchivedResponse {
  id: string;
  source_id: number;
  request_body: string;
  response_body: Buffer;
}

export async function backfillObservations(pool: Pool, limit: number) {
  if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new RangeError("Expected a limit from 1 to 100");
  const result = { indexed: 0, unsupported: 0, occurrences: 0 };
  for (let i = 0; i < limit; i += 1) {
    const outcome = await transaction(pool, async (client) => {
      const { rows: [response] } = await client.query<ArchivedResponse>(
        `SELECT r.id, r.source_id, r.request_body, r.response_body
         FROM rpc_responses r WHERE r.method = $1
          AND NOT EXISTS (SELECT 1 FROM observation_index_results x WHERE x.response_id = r.id)
         ORDER BY r.id LIMIT 1 FOR UPDATE OF r SKIP LOCKED`,
        [VIEW_METHOD],
      );
      if (!response) return null;
      // A worker that finished as this statement took its snapshot may already have indexed this response.
      const indexed = await client.query("SELECT 1 FROM observation_index_results WHERE response_id = $1", [response.id]);
      if (indexed.rowCount) return { indexed: 0, unsupported: 0, occurrences: 0 };

      let occurrences;
      try {
        occurrences = decodeArchivedViewOccurrences(response.request_body, response.response_body);
      } catch (error) {
        if (!(error instanceof RpcError)) throw error;
        await recordUnsupportedViewResponse(client, response.source_id, response.id, error.message);
        return { indexed: 0, unsupported: 1, occurrences: 0 };
      }
      await indexViewResponse(client, response.source_id, response.id, occurrences, true);
      return { indexed: 1, unsupported: 0, occurrences: occurrences.length };
    });
    if (!outcome) break;
    result.indexed += outcome.indexed;
    result.unsupported += outcome.unsupported;
    result.occurrences += outcome.occurrences;
  }
  return result;
}

export async function inspectViewObservations(pool: Pool, sourceId: number, viewId: string, limit = 1_000) {
  if (!Number.isInteger(sourceId) || sourceId < 1 || sourceId > 2_147_483_647) {
    throw new RangeError("Expected a positive PostgreSQL source ID");
  }
  if (!/^(0|[1-9]\d{0,19})$/.test(viewId) || BigInt(viewId) > MAX_UINT64) {
    throw new RangeError("Expected a canonical uint64 view ID");
  }
  if (!Number.isInteger(limit) || limit < 1 || limit > 1_000) throw new RangeError("Invalid observation scan limit");
  return transaction(pool, async (client) => {
    const sourceResult = await client.query(
      "SELECT id, endpoint, chain_id AS \"chainId\", genesis_hash AS \"genesisHash\" FROM sources WHERE id = $1",
      [sourceId],
    );
    const source = sourceResult.rows[0];
    if (!source) throw new Error("Unknown source " + sourceId);

    const { rows: [coverage] } = await client.query<{ pending: boolean; unsupported: boolean }>(
      `SELECT EXISTS (
        SELECT 1 FROM rpc_responses r WHERE r.source_id = $1 AND r.method = $2
           AND NOT EXISTS (SELECT 1 FROM observation_index_results x WHERE x.response_id = r.id)
       ) AS pending, EXISTS (
         SELECT 1 FROM observation_index_results WHERE source_id = $1 AND outcome = 'unsupported'
       ) AS unsupported`,
      [sourceId, VIEW_METHOD],
    );
    const result = await client.query<Observation>(
      `SELECT o.response_id AS "responseId", o.response_index AS "responseIndex",
          (extract(epoch FROM r.observed_at) * 1000000)::bigint::text AS "receiptMicros",
          o.normalized_record AS record
       FROM consensus_view_observations o JOIN rpc_responses r ON r.id = o.response_id
       WHERE o.source_id = $1 AND o.view_id = $2::numeric
       ORDER BY o.response_id, o.response_index LIMIT $3`,
      [sourceId, viewId, limit + 1],
    );
    const rows = result.rows.slice(0, limit);
    const truncated = result.rows.length > limit;
    const complete = !coverage!.pending && !coverage!.unsupported && !truncated;
    return {
      source, viewId, scannedOccurrences: rows.length,
      coverage: { ...coverage, truncated, scope: "archived_responses" },
      ...compareViewObservations(rows, complete),
    };
  }, "read");
}
