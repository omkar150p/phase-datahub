# M1.2 historical API completion report

27 November 2026. All approved acceptance checks passed in an isolated local PostgreSQL database. The release scope is the read-only historical API.

## Baseline and design reconciliation

Local `main` and GitHub `main` started at `0bff099a0eb9d68586d331f9630065c06e58d204` with a clean working tree. The two changes since the M1.1 implementation commit `d33fc47b7869e29cfb1f979e891a215d8ee16423` were the M1.1 completion report and the M1.2 plan. The current code matched the M1.1 report on per-occurrence indexing, original offsets, bounded backfill, raw archive preservation, representative projection selection and atomic poll writes. Its original 39 tests passed again. The earlier report's live checks remain historical evidence.

The audit design described pagination and detail lookups that the baseline API did not expose. M1.1 already wrote `current_response_index`, but the existing API did not select it. The inspection command started its own repeatable-read transaction, so the archive comparison was extracted for reuse inside a request's existing transaction. [M1.1 report](M1_1_COMPLETION_REPORT.md) · [Approved scope](NEXT_MILESTONE_PLAN.md) · [M1.1 poll transaction](../../src/database.ts#L228) · [M1.1 observation schema](../../db/002_observation_integrity.sql)

## Implemented

| Area | Verified behavior |
| --- | --- |
| List | Retains `source`, `blockHeads`, `coverage`, `views`, the default limit of 20, the maximum of 100, and the existing limit error. Returns the additive `page` object. Uses numeric descending keyset pagination, an exclusive bound and a lookahead row. Takes the next cursor from PostgreSQL's last returned numeric ID as a decimal string. |
| Detail | Returns 200 with the projected view, nullable `currentResponseIndex`, provenance, coverage, separate heads and integrity. Invalid IDs or cursors return the documented 400 errors. Unexpected database failures return the existing generic 500. |
| Misses | Resolves `source_unregistered` first, then an active `candidate_sequence_gap` or `unrecoverable_from_source`, then `outside_observed_range` when both bounds exist, and finally `unobserved`. Direct evidence can be older than the capped coverage display. |
| Snapshot | Each request uses one read-only repeatable-read transaction. List `page.asOf` is the database transaction timestamp. Detail coverage, projection, gap evidence and comparison use the same transaction. |
| Integrity | Reuses the M1.1 comparator. It examines at most 1,000 archived occurrences and reads one extra to detect truncation. It returns up to five unique evidence references, prioritizing unresolved findings. Incomplete evidence yields `unknown` in the absence of a material finding. |

The cap of five unique references and priority for unresolved findings are implementation choices within the approved small-evidence contract. The projection exposes its first archived response ID, and the selected representative includes its persisted offset when available. [API](../../src/api.ts#L57) · [Shared integrity read](../../src/observation-tools.ts#L70)

## Tests

Ran `npm ci`, `npm run build` and `npm test` on Node.js 24.22.3 and npm 11.19.1. The complete suite used a newly created loopback PostgreSQL 17.12 cluster through `TEST_DATABASE_URL`, with `DATABASE_URL` removed from the test process. The temporary instance was stopped after the run. The initial suite run surfaced an ambiguous timestamp cast in a test fixture and missing block-head sampling in fixture setup. Both were corrected before the final run.

~~~text
tests 54
suites 0
pass 54
fail 0
cancelled 0
skipped 0
todo 0
duration_ms 10884.2005
~~~

| Acceptance check | Automated evidence |
| --- | --- |
| Backward compatibility | 39 original M1.1 tests pass, including migrations, byte preservation, idempotency, checkpoint rollback, restart and collector behavior. |
| Pagination and validation | Default and explicit limits 1, 20, 50 and 100, exact/terminal/empty pages, exclusive and in-gap cursors, numeric ordering around `2^53`, zero, uint64 max, overflow, malformed/encoded/repeated parameters, late inserts on both sides of a cursor and generic 500s. |
| Lookup and isolation | All five miss states, old direct gap evidence, superseded gaps, observed-row precedence, source registration without bounds, and independent results for another endpoint and a different chain identity. |
| Provenance and integrity | Current/first response linkage, nullable legacy offsets, receipt and ingestion timestamps, separate heads, identical/transition/conflicting occurrences, pending and unsupported archive evidence, truncation, and the caps of 1,000 compared occurrences and five unique evidence references. |
| Transaction consistency | Controlled commits between actual PostgreSQL reads verify list results and metadata, 200 detail results and integrity, and 404 coverage and active gaps. |
| Query plan and budget | The three production query strings are explained with a large scratch dataset. The suite asserts the index access paths and measures local HTTP response sizes and latencies. |

[Historical API integration tests](../../test/historical-api.integration.test.ts) · [Existing collector tests](../../test/collector.integration.test.ts) · [Existing RPC tests](../../test/rpc.test.ts)

## Archived Phase fixture results

The tests replayed captures through a local RPC fixture server and the existing collector. All three archived views had two occurrences with varying signer membership and returned `unresolved`. The fixture manifest checks remain part of the full suite.

| View | Capture | Evidence offsets |
| --- | --- | --- |
| `8294199` | `live-order-11.json` | 20 and 22 |
| `8294232` | `live-order-11.json` | 53 and 55 |
| `8294794` | `live-order-12.json` | 14 and 16 |

[Fixture replay test](../../test/historical-api.integration.test.ts#L271) · [Captured fixture directory](../../fixtures/phase-mainnet)

## Sample requests and response excerpts

`GET /v1/consensus/views?limit=2&beforeViewId=8294200` returned 200 during fixture replay. The shown view objects contain only their IDs. The full response also carries source, coverage, block heads and the established row fields.

~~~json
{
  "views": [
    { "record": { "viewId": "8294199" } },
    { "record": { "viewId": "8294198" } }
  ],
  "page": {
    "limit": 2,
    "beforeViewId": "8294200",
    "nextBeforeViewId": "8294198",
    "hasMore": true,
    "asOf": "2026-11-27T09:56:27.433Z"
  }
}
~~~

`GET /v1/consensus/views/8294199` returned 200 in the same run. The endpoint below is the fixture server. The collector receipt and ingestion dates are from the replay.

~~~json
{
  "view": {
    "record": {
      "viewId": "8294199",
      "certificateStatus": "full",
      "viewTimestampSecs": "1795712686"
    },
    "rpcMethod": "phase_getViewRecords",
    "firstResponseId": "3",
    "currentResponseId": "3",
    "currentResponseIndex": 22,
    "firstObservedAt": "2026-11-27T09:56:27.342Z",
    "ingestedAt": "2026-11-27T09:56:27.366Z"
  },
  "source": {
    "endpoint": "http://127.0.0.1:53645",
    "chainId": "1015",
    "genesisHash": "0x50b453b2fc402366a4341b111cd63539676277199c34339f07a10e73f964e2f7",
    "status": "source_observed",
    "registered": true
  },
  "blockHeads": {
    "latest": { "height": "8284709", "responseId": "4" },
    "finalized": { "height": "8284707", "responseId": "5" }
  },
  "integrity": {
    "status": "unresolved",
    "findingTypes": ["signer_membership_variation", "reported_signer_count_variation"],
    "scannedOccurrences": 2,
    "coverage": { "pending": false, "unsupported": false, "truncated": false, "scope": "archived_responses" },
    "evidence": [
      { "responseId": "3", "responseIndex": 20 },
      { "responseId": "3", "responseIndex": 22 }
    ]
  }
}
~~~

`GET /v1/consensus/views/15` returned 404 against the synthetic gap fixture. The actual response also included `source` and `coverage`.

~~~json
{
  "error": "view_not_found",
  "viewId": "15",
  "lookupState": "candidate_sequence_gap",
  "gap": {
    "state": "candidate_sequence_gap",
    "firstViewId": "14",
    "lastViewId": "16",
    "detectedAt": "2026-11-26T12:34:56.789Z",
    "evidenceResponseId": "1"
  }
}
~~~

## Query plans and performance

The scratch dataset contained 100,000 representative views, 100,000 indexed occurrences, 500 synthetic response envelopes and 10,000 active gaps under one source. View IDs exceed JavaScript's safe integer range. PostgreSQL statistics were refreshed with `ANALYZE` before `EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON)` on the exact API statements.

| Query | Observed plan | PostgreSQL execution |
| --- | --- | ---: |
| 50-view keyset page with 51-row lookahead | Backward `consensus_views_pkey` index scan with `source_id = 1` and `view_id < 9007199254795990` as index conditions. Nested-loop join with memoized `rpc_responses_source_id_id_key` lookups. | 0.160 ms |
| Exact detail | `consensus_views_pkey` equality scan for source and view ID, joined through `rpc_responses_source_id_id_key`. | 0.040 ms |
| Direct gap hit | Backward `active_view_gaps_by_source` index scan with source and both interval bounds as index conditions, followed by an incremental sort for deterministic tie-breaking and a limit. | 0.796 ms |

Fastify injection measured five requests per case after a warm-up. Body sizes are uncompressed UTF-8. The timings capture local request handling and PostgreSQL reads. The synthetic benchmark had no block-head history.

| Request | Body bytes | Median | Maximum |
| --- | ---: | ---: | ---: |
| List, 50 views | 40,898 | 6.03 ms | 6.32 ms |
| List, 100 views | 77,749 | 6.57 ms | 9.04 ms |
| Detail, one occurrence | 4,868 | 3.53 ms | 6.73 ms |
| Missing detail, active gap | 4,116 | 3.14 ms | 4.34 ms |
| Integrity queries and comparison, one occurrence | — | 0.96 ms | 1.22 ms |

A separate request comparing 1,000 occurrences while detecting truncation returned 1,780 bytes in 20.43 ms against the smaller cap-test dataset. [Benchmark and EXPLAIN assertions](../../test/historical-api.integration.test.ts#L574) · [Cap test](../../test/historical-api.integration.test.ts#L369)

## Files and migrations

| Change | File |
| --- | --- |
| Modified | [src/api.ts](../../src/api.ts) |
| Modified | [src/observation-tools.ts](../../src/observation-tools.ts) |
| Modified | [package.json](../../package.json) |
| Added | [test/historical-api.integration.test.ts](../../test/historical-api.integration.test.ts) |
| Added | `docs/audit/M1_2_COMPLETION_REPORT.md` |
| Updated | [docs/audit/NEXT_MILESTONE_PLAN.md](NEXT_MILESTONE_PLAN.md) |

Existing schema versions 001 and 002 cover the new read paths. No new migration or index was required by the measured cases. The existing development and production databases and their raw evidence were outside the test run.

## Scope and remaining limits

- The approved HTTP contract passed local validation. Live verification for this milestone was limited to replaying archived evidence. The 24-hour collector soak and external readiness checks remain pending from M1.1.
- Paging snapshots are per request. A repair above a cursor already crossed becomes visible on a fresh traversal. A new source identity needs a new traversal.
- Pending or unsupported archived RPC responses are flagged conservatively across their source. Comparisons cover archived occurrences and the configured cap.
- Local benchmark timings cover a single source and warm reads. Larger response archives, long block-head histories, gap lookups without a matching interval and concurrent public traffic were outside the benchmark.

**GO for the approved local M1.2 historical API scope.**
