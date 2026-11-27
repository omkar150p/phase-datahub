# M1.1 implementation plan

Approval package for Phase DataHub, dated 27 November 2026. Baseline is public `main` at `13f36545f86cfe9c071f3da468c6920892a67341`. The checkout matched the public Git remote. The published CI run passed, and a fresh local run passed 30 tests on Node 24.22.3 and PostgreSQL 17.12. The 24-hour run remains pending. [Published CI run](https://github.com/omkar150p/phase-datahub/actions/runs/45880222377) · [Test scripts](https://github.com/omkar150p/phase-datahub/blob/13f36545f86cfe9c071f3da468c6920892a67341/package.json#L9-L16)

## Decision for this milestone

Review the four designs below. The first implementation slice should make repeated occurrences queryable while preserving every raw body and the existing one-row view projection. The historical routes and public integrity fields require explicit contract review. Storage and deployment work follow separate approval.

| Review document | Main decision |
| --- | --- |
| [Observation integrity](OBSERVATION_INTEGRITY.md) | Save each accepted occurrence with its response and zero-based index. Compare scoped observations and keep unresolved evidence alongside the representative projection. |
| [Historical API design](HISTORICAL_API_DESIGN.md) | Use bounded descending keyset pagination with exact uint64 decimal-string cursors. Return view detail with source, coverage and evidence references. |
| [Raw evidence storage strategy](STORAGE_STRATEGY.md) | Add independently verified compressed copies and rehearse a restore while retaining the PostgreSQL raw bodies. |
| [Production readiness](PRODUCTION_READINESS.md) | Introduce additive migrations and gate external service rollout on measurable health, limits and a live soak. Take repository policy decisions with the owner. |

## Proposed sequence after approval

| Order | Work and likely touch points | Evidence required to advance |
| --- | --- | --- |
| 1 | Version migrations around the current `001_init.sql` with a checked baseline for existing installations. Add a new migration for occurrence storage. Keep the existing checkpoint and source-scoped projection constraints. [src/migrate.ts:5–18](https://github.com/omkar150p/phase-datahub/blob/13f36545f86cfe9c071f3da468c6920892a67341/src/migrate.ts#L5-L18) · [src/database.ts:39–67](https://github.com/omkar150p/phase-datahub/blob/13f36545f86cfe9c071f3da468c6920892a67341/src/database.ts#L39-L67) · [db/001_init.sql:9–49](https://github.com/omkar150p/phase-datahub/blob/13f36545f86cfe9c071f3da468c6920892a67341/db/001_init.sql#L9-L49) | Fresh and populated upgrades, re-run and concurrent migration, drift and rollback tests. Existing raw responses, view projections and coverage must be unchanged after the schema upgrade. |
| 2 | Materialize normalized wire occurrences during accepted polls, including superseded evidence and retention probes. Replay historical raw responses through a bounded, restartable backfill. Add source-scoped comparison rules and internal evidence inspection. [src/phase-rpc.ts:117–166](https://github.com/omkar150p/phase-datahub/blob/13f36545f86cfe9c071f3da468c6920892a67341/src/phase-rpc.ts#L117-L166) · [src/collector.ts:33–74](https://github.com/omkar150p/phase-datahub/blob/13f36545f86cfe9c071f3da468c6920892a67341/src/collector.ts#L33-L74) · [src/database.ts:217–286](https://github.com/omkar150p/phase-datahub/blob/13f36545f86cfe9c071f3da468c6920892a67341/src/database.ts#L217-L286) | All expected occurrences and original offsets are recoverable, including the six repeated groups across the two public fixtures. Same-hash signer variation remains visible. Existing projection choices, gaps and cursor behavior match the baseline. A failed occurrence write rolls back with the poll. A repeated or restarted backfill leaves one occurrence per response/index. Unsupported historical bodies have recorded exceptions. |
| 3 | After a separate API contract review, add view detail and the optional `beforeViewId` cursor. Introduce a bounded integrity summary once occurrence coverage is available. [src/api.ts:24–104](https://github.com/omkar150p/phase-datahub/blob/13f36545f86cfe9c071f3da468c6920892a67341/src/api.ts#L24-L104) · [Historical API design](HISTORICAL_API_DESIGN.md) | Backward-compatible list, uint64 boundaries, exclusive paging, absent-view classifications, provenance, coverage snapshot and capped evidence tests. Measure query plans and latency at representative history size. |
| 4 | Run an approved 24-hour collection soak using the intended runtime and ordinary RPC limits. Record current vs baseline write cost, checkpoint progress, duplicates, unresolved findings, observed downtime, retention gaps and storage/WAL growth. [src/collector.ts:77–117](https://github.com/omkar150p/phase-datahub/blob/13f36545f86cfe9c071f3da468c6920892a67341/src/collector.ts#L77-L117) · [Production readiness](PRODUCTION_READINESS.md) | Every committed view response is indexed or has a recorded exception. No silent checkpoint advancement on failures. Explain observed gaps and stale periods. Gather enough volume and latency data to set archive and readiness budgets. |
| 5 | Pilot compressed storage with a verified export ledger, then rehearse restoration. Run the exporter outside the collector transaction. [src/database.ts:69–79](https://github.com/omkar150p/phase-datahub/blob/13f36545f86cfe9c071f3da468c6920892a67341/src/database.ts#L69-L79) · [Raw evidence storage strategy](STORAGE_STRATEGY.md) | Byte-identical round trip, retry reconciliation, corruption detection and recovery into an isolated DB. PostgreSQL continues retaining the evidence during the pilot. |
| 6 | Harden the API before external hosting and finalize repository policy at the owner's direction. Add bounded health/readiness and rate limits with regression coverage. [src/api-main.ts:6–25](https://github.com/omkar150p/phase-datahub/blob/13f36545f86cfe9c071f3da468c6920892a67341/src/api-main.ts#L6-L25) · [Production readiness](PRODUCTION_READINESS.md) | Operator confirms load targets, readiness behavior, restore evidence and reporting route. Owner confirms the license decision and supported versions. |

## Risks and boundaries

- **Interpretation.** The source can return several signer lists for one hash, including timestamp ties. Keep the existing projection for compatible reads. Attach evidence and a clearly scoped unresolved state to meaningful disagreements. The captured data leaves consensus validity open.
- **Write amplification.** Per-occurrence storage can grow faster than the view table. Measure the 10,000-entry path and keep the backfill bounded. Derive summaries on demand initially and add persistent summaries only if necessary.
- **History visibility.** The existing API is per-source and transaction-consistent within one request. Cursor paging has a documented late-repair trade-off across requests.
- **Evidence durability.** Export recovery and PostgreSQL backups protect different parts of state. Keep the existing raw bodies and all evidence references. Database tier changes and retention rules require their own decision.
- **Release scope.** The work extends the current collector, schema, tests and read API. Additional modules, independent verification, dashboard work and general platform redesign are outside this milestone.

## Implementation status

Steps 1 and 2 are implemented. A local upgrade preserved 14 raw responses, 163 existing projections, checkpoints and gap records. Backfill indexed 10,180 occurrences across four saved view responses. A second run added zero occurrences. All 39 automated tests passed locally. See the [operator commands](../operations.md#observation-integrity).

## Remaining approvals

Review the historical API contract before implementing the detail route, paging and public integrity fields. Confirm the live-soak schedule, storage retention and repository policy separately.
