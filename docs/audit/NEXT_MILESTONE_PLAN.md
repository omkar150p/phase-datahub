# M1.2 historical API scope

This is the implementation brief for human review, dated 27 November 2026. It extends the [historical API design](HISTORICAL_API_DESIGN.md) using the M1.1 observation index on `main` at `d33fc47b7869e29cfb1f979e891a215d8ee16423`. Implementation remains pending.

## 1. Paginate the existing view list

Extend `GET /v1/consensus/views?limit=50&beforeViewId=8294200`. Keep the current default limit of 20, the maximum of 100, and the existing response fields and limit error body. Add a `page` object with `limit`, `beforeViewId`, `nextBeforeViewId`, `hasMore` and ISO 8601 `asOf`.

Validate a cursor once as a canonical uint64 decimal string. Accept zero and the exact maximum `18446744073709551615`. Reject leading zeroes, signs, exponent and fraction syntax, repeated query parameters, and overflow. Use `BigInt` for bounds and pass the original validated string as a PostgreSQL `numeric` parameter. Use the same validation for the detail route. [src/api.ts:24–39](https://github.com/omkar150p/phase-datahub/blob/d33fc47b7869e29cfb1f979e891a215d8ee16423/src/api.ts#L24-L39) · [src/phase-rpc.ts:6–11](https://github.com/omkar150p/phase-datahub/blob/d33fc47b7869e29cfb1f979e891a215d8ee16423/src/phase-rpc.ts#L6-L11)

Page by `source_id` and the exclusive predicate `view_id < beforeViewId`, in descending numeric order. Fetch `limit + 1`. Use the last returned view ID as `nextBeforeViewId` when the extra row exists. Terminal and empty pages carry a null next cursor. A cursor can fall in an unobserved interval. Keep the old empty list behavior for an unregistered source. This should fit the existing primary key on `(source_id, view_id)`. Verify the query plan on a realistically sized data set. [src/api.ts:60–72](https://github.com/omkar150p/phase-datahub/blob/d33fc47b7869e29cfb1f979e891a215d8ee16423/src/api.ts#L60-L72) · [db/001_init.sql:34–49](https://github.com/omkar150p/phase-datahub/blob/d33fc47b7869e29cfb1f979e891a215d8ee16423/db/001_init.sql#L34-L49)

Each page and its metadata share one transaction snapshot. `asOf` identifies that request's database time. Late repairs above a crossed boundary can appear in a fresh traversal. Clients should restart paging if the source identity changes.

## 2. Add individual view lookup

Add `GET /v1/consensus/views/:viewId`. Look up a view by configured source and numeric ID.

| Result | Contract |
| --- | --- |
| 200 | Return the existing row shape as `view`, alongside `source`, `blockHeads`, `coverage` and the bounded integrity summary. |
| 400 | Return `invalid_view_id` for invalid path values and `invalid_before_view_id` for invalid list cursors. |
| 404 | Return `view_not_found`, the requested ID, `lookupState` and source/coverage metadata. A matching active gap includes its interval and evidence response ID. |
| 500 | Preserve the service's generic error for unexpected failures. |

For a valid missing ID, apply the following precedence.

1. Use `source_unregistered` when the endpoint and chain identity have no matching source.
2. For a registered source, query the active gap that directly contains the ID. Return `candidate_sequence_gap` or `unrecoverable_from_source` with its evidence. The capped recent gap list is display metadata.
3. Use `outside_observed_range` when both observed bounds exist and the ID falls outside them.
4. Use `unobserved` for an in-range miss without explicit gap evidence, or when a registered source has yet to establish bounds.

An unrecoverable interval is scoped to the reporting source and the time of the retention probe. Later observations can supersede it. [src/api.ts:33–91](https://github.com/omkar150p/phase-datahub/blob/d33fc47b7869e29cfb1f979e891a215d8ee16423/src/api.ts#L33-L91) · [db/001_init.sql:52–66](https://github.com/omkar150p/phase-datahub/blob/d33fc47b7869e29cfb1f979e891a215d8ee16423/db/001_init.sql#L52-L66) · [src/database.ts:146–187](https://github.com/omkar150p/phase-datahub/blob/d33fc47b7869e29cfb1f979e891a215d8ee16423/src/database.ts#L146-L187)

## 3. Attach observation integrity and provenance

Preserve endpoint, chain ID, genesis hash, first and current response IDs, occurrence offset when available, and the existing observation, update and ingestion times. Keep the node-reported view timestamp distinct from collector receipt time. Keep reported latest and finalized heads separate from the representative certificate.

For detail reads, derive a source-scoped summary with `status`, `findingTypes`, the scan size, coverage flags and a small capped set of evidence references. Each reference contains a decimal-string response ID and a zero-based occurrence offset. Reuse M1.1 comparison semantics. An observed discrepancy can establish `unresolved` during a partial scan. With no material finding and incomplete evidence, report `unknown`. Scope no-discrepancy results to archived responses. Reuse the request's repeatable-read transaction for the view, coverage and comparisons, rather than starting the internal inspection command's separate transaction. [src/api.ts:32–104](https://github.com/omkar150p/phase-datahub/blob/d33fc47b7869e29cfb1f979e891a215d8ee16423/src/api.ts#L32-L104) · [src/observation-tools.ts:51–94](https://github.com/omkar150p/phase-datahub/blob/d33fc47b7869e29cfb1f979e891a215d8ee16423/src/observation-tools.ts#L51-L93) · [src/observation-findings.ts:36–127](https://github.com/omkar150p/phase-datahub/blob/d33fc47b7869e29cfb1f979e891a215d8ee16423/src/observation-findings.ts#L36-L127)

Start with a detail-only summary. Review list summaries after measuring response size and query cost. Keep the evidence list bounded and preserve references to the raw archive.

## 4. Acceptance checks

- Keep existing list, rollback and checkpoint tests green. Exercise limits 1, 20, 50 and 100, exact and final pages, empty archives, exclusive cursors, cursors inside gaps, numeric ordering, values around `2^53` and uint64 overflow. Reject malformed and repeated inputs with the documented errors.
- Cover all five 404 classifications, including a gap older than the metadata list cap. Test isolation from a different source, whole-response snapshot consistency and current provenance fields.
- Exercise conflicting and identical occurrences, partial/unsupported evidence, more occurrences than the scan cap, bounded evidence output and nullable legacy offsets. Use fixture-backed test data for the three historical IDs and assert their unresolved signer differences when seeded.
- Check the execution plan for descending keyset reads, detail lookup and direct gap lookup. Measure the summary's query latency and response size on an isolated database. Any additional index or list-level summary should be justified by those measurements.

## Review gate

Approve the list and detail contracts, missing-view precedence and integrity payload before M1.2 starts. The completion audit and this plan are documentation deliverables. The 24-hour collector soak and external-service readiness remain separate validation work. [M1.1 completion report](M1_1_COMPLETION_REPORT.md)
