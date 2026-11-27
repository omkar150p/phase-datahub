import type { PoolClient } from "pg";
import type { ViewOccurrence } from "./phase-rpc.js";

const NORMALIZER_VERSION = 1;

export async function indexViewResponse(
  client: PoolClient, sourceId: number, responseId: string, occurrences: ViewOccurrence[], replay = false,
): Promise<void> {
  const rows = JSON.stringify(occurrences);
  if (occurrences.length > 0) {
    await client.query(
      `INSERT INTO consensus_view_observations (
        source_id, response_id, response_index, view_id, view_timestamp_secs, certificate_status,
        epoch, committee_round, block_hash, normalized_record, normalizer_version
      )
      SELECT $1, $2, (value->>'responseIndex')::integer, (record->>'viewId')::numeric,
        (record->>'viewTimestampSecs')::numeric, record->>'certificateStatus', (record->>'epoch')::numeric,
        (record->>'committeeRound')::numeric, record->>'blockHash', record, $4
      FROM jsonb_array_elements($3::jsonb) CROSS JOIN LATERAL (SELECT value->'record' AS record) AS data`
        + (replay ? " ON CONFLICT (response_id, response_index) DO NOTHING" : ""),
      [sourceId, responseId, rows, NORMALIZER_VERSION],
    );
  }
  if (replay) {
    const result = await client.query<{ matches: boolean }>(
      `SELECT COALESCE(jsonb_agg(jsonb_build_object(
        'responseIndex', response_index, 'record', normalized_record
      ) ORDER BY response_index), '[]'::jsonb) = $2::jsonb
        AND COALESCE(bool_and(
          source_id = $3 AND normalizer_version = $4
          AND view_id = (normalized_record->>'viewId')::numeric
          AND view_timestamp_secs = (normalized_record->>'viewTimestampSecs')::numeric
          AND certificate_status = normalized_record->>'certificateStatus'
          AND epoch = (normalized_record->>'epoch')::numeric
          AND committee_round = (normalized_record->>'committeeRound')::numeric
          AND block_hash IS NOT DISTINCT FROM (normalized_record->>'blockHash')
        ), true) AS matches
      FROM consensus_view_observations WHERE response_id = $1`,
      [responseId, rows, sourceId, NORMALIZER_VERSION],
    );
    if (!result.rows[0]?.matches) throw new Error("Conflicting indexed observations for response " + responseId);
  }
  await client.query(
    "INSERT INTO observation_index_results " +
    "(source_id, response_id, normalizer_version, outcome, occurrence_count) VALUES ($1, $2, $3, 'indexed', $4)",
    [sourceId, responseId, NORMALIZER_VERSION, occurrences.length],
  );
}

export async function recordUnsupportedViewResponse(
  client: PoolClient, sourceId: number, responseId: string, message: string,
): Promise<void> {
  await client.query(
    "INSERT INTO observation_index_results " +
    "(source_id, response_id, normalizer_version, outcome, error_message) VALUES ($1, $2, $3, 'unsupported', $4)",
    [sourceId, responseId, NORMALIZER_VERSION, message.slice(0, 500)],
  );
}
