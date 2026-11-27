# Historical consensus API design

Design for review. Baseline is published `main` at `13f36545f86cfe9c071f3da468c6920892a67341`.

## Current contract

`GET /v1/consensus/views` returns `source`, `blockHeads`, `coverage` and `views`. The current source is selected by configured endpoint, Phase chain ID and genesis hash. Rows are sorted by numeric view ID descending. The default limit is 20 and the maximum is 100. The coverage object describes the source archive and shows up to 20 active view gaps and 20 collector observation gaps. It is independent of the returned row set. [README.md:22–35](https://github.com/omkar150p/phase-datahub/blob/13f36545f86cfe9c071f3da468c6920892a67341/README.md#L22-L35) · [src/api.ts:24–104](https://github.com/omkar150p/phase-datahub/blob/13f36545f86cfe9c071f3da468c6920892a67341/src/api.ts#L24-L104)

## List with a cursor

`GET /v1/consensus/views?limit=50&beforeViewId=8294200`

- Keep the existing fields, status codes, default limit and maximum. Add a `page` object with `limit`, `beforeViewId`, `nextBeforeViewId`, `hasMore` and `asOf`. Both cursor fields are strings or null. `asOf` is the database transaction timestamp for this request, in ISO 8601.
- An optional `beforeViewId` is an exclusive upper bound. Build the predicate `view_id < $bound::numeric` alongside `source_id = $source` and the existing descending order. Bind the validated decimal string. Keep a query branch without the cursor predicate for the first page. With the existing composite primary key, this should use a backward index traversal without an offset. Confirm the plan on realistic data. [src/api.ts:60–70](https://github.com/omkar150p/phase-datahub/blob/13f36545f86cfe9c071f3da468c6920892a67341/src/api.ts#L60-L70) · [db/001_init.sql:34–49](https://github.com/omkar150p/phase-datahub/blob/13f36545f86cfe9c071f3da468c6920892a67341/db/001_init.sql#L34-L49)
- Fetch `limit + 1` rows. Return at most `limit`, with `hasMore: true` and the last **returned** ID as `nextBeforeViewId` when the extra row exists. The next request passes that string unchanged. Empty and terminal pages return null as the next cursor. The cursor can point between archived IDs or into a known gap.
- Continue returning the current successful empty response for an unregistered source, extended with empty pagination metadata. Echo the source on every page. Numeric cursors are scoped to that source, so clients should restart paging if the endpoint, genesis hash or chain ID changes.
- Each response keeps its existing repeatable-read transaction. A page and its coverage describe the same committed database state. Separate requests can observe updates and late repairs. A repair above a boundary already passed will appear after a fresh traversal. A descending keyset avoids duplicates from new higher IDs during forward paging. Cross-request snapshot identifiers would need versioned data and are outside this design. [src/api.ts:32–104](https://github.com/omkar150p/phase-datahub/blob/13f36545f86cfe9c071f3da468c6920892a67341/src/api.ts#L32-L104) · [src/database.ts:39–58](https://github.com/omkar150p/phase-datahub/blob/13f36545f86cfe9c071f3da468c6920892a67341/src/database.ts#L39-L58)

## Detail endpoint

`GET /v1/consensus/views/:viewId`

| Response | Contract |
| --- | --- |
| `200` | Return `view` as the same row shape used by the list, plus `source`, `coverage` and the sampled `blockHeads`. Lookup is `source_id = $source AND view_id = $id::numeric`. Preserve all existing times, method and first/current evidence response IDs. |
| `400` | Return `invalid_view_id` for a malformed path ID, and `invalid_before_view_id` for a malformed list cursor. Keep the existing list limit validation and error body. |
| `404` | Return `view_not_found`, the requested ID, source and coverage. Add a `lookupState` of `source_unregistered`, `outside_observed_range`, `candidate_sequence_gap`, `unrecoverable_from_source` or `unobserved`. Include active gap bounds and its evidence response ID when a gap contains the ID. |
| `500` | Preserve generic internal-error behavior for unexpected failures. Database readiness and rate limiting are separate production work. |

For a missing row, check the active gap containing the requested numeric ID directly. The coverage list is capped, so it cannot be used to infer whether the requested ID has gap evidence. If there is no matching active interval, use source registration and the archived first/high boundaries to classify lookup state. A registered source with no observed bounds or a miss inside the bounds is `unobserved`. A source-unrecoverable interval records the source's retained window at the time it was inspected. It may later be superseded if new evidence arrives. [src/api.ts:33–91](https://github.com/omkar150p/phase-datahub/blob/13f36545f86cfe9c071f3da468c6920892a67341/src/api.ts#L33-L91) · [db/001_init.sql:52–66](https://github.com/omkar150p/phase-datahub/blob/13f36545f86cfe9c071f3da468c6920892a67341/db/001_init.sql#L52-L66) · [src/database.ts:135–176](https://github.com/omkar150p/phase-datahub/blob/13f36545f86cfe9c071f3da468c6920892a67341/src/database.ts#L135-L176)

### IDs, integrity and provenance

- Validate the decoded path or query value once as a string matching `^(0|[1-9][0-9]{0,19})$`, then compare its `BigInt` value to `18446744073709551615n`. Preserve the canonical string when binding to PostgreSQL and serializing responses. Reject repeated query parameters, leading zeroes, signs, fractional/exponent input and overflow. The existing decoder already preserves uint64 values as decimal strings. [src/phase-rpc.ts:6–11](https://github.com/omkar150p/phase-datahub/blob/13f36545f86cfe9c071f3da468c6920892a67341/src/phase-rpc.ts#L6-L11) · [src/phase-rpc.ts:90–95](https://github.com/omkar150p/phase-datahub/blob/13f36545f86cfe9c071f3da468c6920892a67341/src/phase-rpc.ts#L90-L95)
- Keep the view's source timestamp in `record.viewTimestampSecs`, and keep `firstObservedAt`, `lastObservedAt`, `lastUpdatedAt` and `ingestedAt` as separate dates. Preserve source-reported `latest` and `finalized` block heads independently of the selected certificate.
- After occurrence indexing and coverage accounting are approved, add a bounded `integrity` summary on detail responses. Use `status`, `findingTypes` and archive-evidence coverage. Include a small capped list of `{responseId, responseIndex}` pairs with decimal-string response IDs and zero-based integer offsets. Expose a lightweight summary on list rows only after measuring query cost. A partial scan can still establish an unresolved finding. The evidence-coverage field tells callers how much of the archive was checked. No-discrepancy status is scoped to the materialized observations. [Observation integrity design](OBSERVATION_INTEGRITY.md)
- Leave raw body retrieval outside these endpoints. Raw bodies can be large and evidence references can remain stable independently of the hot/cold storage decision. Keep summary fields additive so existing callers can continue decoding the current response.

## Trade-offs and required tests

- Keyset paging is index-friendly and easy to inspect. It deliberately tolerates late writes between requests. Test inserts above the page boundary, a late repair below it, an updated projection and a change of configured source on a later request.
- Exercise `0`, values around `2^53`, uint64 max, overflow, leading zeroes, repeated parameters and encoded invalid characters. Page across IDs such as `9`, `10` and `100` to prove numeric ordering. Test limit 1, default, 50 and 100, exact-limit and final-page behavior, cursor equality exclusion, an empty result and a cursor inside a gap.
- Test detail hits for the configured source, valid misses for each lookup state, and a gap older than the capped coverage list. Confirm machine-readable errors, existing field types, source timestamps, metadata snapshot consistency and any later conflict summary bounds. Require both historical routes to use parameterized queries and compare query plans with production-like cardinality. [test/collector.integration.test.ts:341–432](https://github.com/omkar150p/phase-datahub/blob/13f36545f86cfe9c071f3da468c6920892a67341/test/collector.integration.test.ts#L341-L432)
