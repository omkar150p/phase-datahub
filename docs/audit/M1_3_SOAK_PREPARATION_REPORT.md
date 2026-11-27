# M1.3 collector soak preparation report

27 November 2026 (IST) · **Prepared for review. The 24-hour soak is incomplete and has not started.**

## Baseline verified

| Check | Result |
| --- | --- |
| Source | Local and GitHub `main` pointed to `1947a1e9f3328a235295a57fcad86cf92b1193d7`. The worktree was clean before this report. |
| GitHub Actions | The push workflow at that exact SHA succeeded, including `npm ci` and `npm test` on Node 24 with a PostgreSQL 17 service. |
| Full-suite baseline | M1.2 recorded 54 passing tests, zero failures and zero skips on a fresh PostgreSQL 17.12 cluster. The current suite contains 15 RPC, 24 collector/database and 15 historical API tests. |
| Checks run for this report | TypeScript reported no diagnostics. All 19 existing JavaScript outputs matched an in-memory build. The 15 RPC and fixture tests passed locally with zero failures or skips and both database URL variables unset. |
| Archive excluded | M1.1 identified the historical local archive as `phase_datahub` on loopback port `55432`. No connection to it was opened for this report. |
| Candidate host | Read-only Compute Engine inspection confirmed `phase-datahub-vps` in `phase-datahub-261127 / asia-south1-a` is running on `e2-medium` with a 30 GiB balanced boot disk. VM deletion is configured for 21 December 2026 at 23:00 IST, with boot-disk auto-delete. Guest free space and runtime inventory remain preflight checks. |

The exact-commit CI run and M1.2 results cover database integration. Those tests create and clear scratch schemas and exercise backfill, so this read-only phase ran the RPC and fixture tests only. The M0 and M1.1 smoke tests are historical live evidence. This preparation used no new mainnet collection or PostgreSQL commands. [Reviewed commit](https://github.com/omkar150p/phase-datahub/commit/1947a1e9f3328a235295a57fcad86cf92b1193d7) · [Successful CI run](https://github.com/omkar150p/phase-datahub/actions/runs/45979726368) · [Workflow](../../.github/workflows/tests.yml) · [M1.1 audit](M1_1_COMPLETION_REPORT.md) · [M1.2 audit](M1_2_COMPLETION_REPORT.md) · [VM](https://console.cloud.google.com/compute/instancesDetail/zones/asia-south1-a/instances/phase-datahub-vps?project=phase-datahub-261127)

## Collector and archive review

| Behavior | Soak check |
| --- | --- |
| Startup checks chain ID and genesis, registers or reuses the source, and archives the identity replies. | Verify endpoint, source ID, chain ID `1015` and genesis `0x50b453b2fc402366a4341b111cd63539676277199c34339f07a10e73f964e2f7` on both invocations. Extra identity responses on restart are expected. [Startup](../../src/collector-main.ts#L8) · [Identity](../../src/phase-rpc.ts#L272) |
| A winning poll locks the checkpoint, saves the raw page and any probe, indexes wire occurrences, reconciles projections and gaps, and advances the checkpoint in one PostgreSQL transaction. A superseded poll can archive evidence without advancing it. | Check revision and high-view progression against winning polls. Investigate any superseded poll with a single writer. A rollback can leave a sequence number unused. [Transaction](../../src/database.ts#L38) · [Poll commit](../../src/database.ts#L228) |
| Restart reads the committed high view. With the default overlap, its first request from a non-null checkpoint uses `max(0, min(uint64_max, high + 1 - 8))`. Catch-up depends on the wire count, including duplicate IDs. | Verify the exact first cursor and preserve all occurrence positions, including repeated and out-of-order view IDs. Compare view IDs using bigint arithmetic. [Polling](../../src/collector.ts#L33) · [Resume cursor](../../src/collector.ts#L119) · [Decoder](../../src/phase-rpc.ts#L148) |
| The client times out each attempt and uses jittered exponential backoff. Rate-limit errors can impose a shared cooldown. Successful bodies are capped at 32 MiB. Method-specific checks run after JSON-RPC envelope validation. | Count actual attempts and typed outcomes separately. `rpc_error.willRetry` records intent, since shutdown during backoff can cancel the next attempt. [Body reader](../../src/phase-rpc.ts#L200) · [Retry loop](../../src/phase-rpc.ts#L309) · [HTTP attempt](../../src/phase-rpc.ts#L352) |
| SIGINT and SIGTERM abort in-flight RPCs and delays. The process closes the pool. A PostgreSQL transaction already in progress can settle during shutdown. | Take the restart checkpoint after exit. Pair the application stop event with process exit status, signal and timestamps. [Signals and shutdown](../../src/collector-main.ts#L8) · [Collector loop](../../src/collector.ts#L92) |
| The committed archive keeps exact response bytes in `rpc_responses`. It has no per-response digest or pre-commit request ledger. | Keep an independent capture to detect valid replies that never committed, archived bytes that changed, and rejected responses. Count pending and unsupported database outcomes separately. [Archive write](../../src/database.ts#L64) · [Occurrence index](../../src/observation-index.ts#L6) · [Schema](../../db/001_init.sql#L9) |
| Gap candidates come from numeric ID discontinuities. An unrecoverable interval has source retention-floor evidence. Collector observation gaps come from elapsed time between successful receipts. | Compare raw pages, cursors, floor evidence and the process timeline. Keep source omissions and collection downtime separate, with ambiguous intervals explicitly unresolved. [Gap update](../../src/database.ts#L146) · [Saved RPC evidence](../rpc-evidence.md) |

## Environment and services

Use the checked-in defaults and pin exact Node 24 and PostgreSQL 17 versions in the run manifest. The application declares Node `>=22.12`. Build from the npm lockfile. Configuration comes from the process environment. There is no tracked `.env.example`. [README](../../README.md) · [Operations](../operations.md) · [Configuration](../../src/config.ts#L19) · [Package scripts](../../package.json)

| Variable | Value or use |
| --- | --- |
| `DATABASE_URL` | Required by the collector, migration, API and observation CLI. Inject the isolated writer connection into the collector only. The migration receives separate credentials for the verified empty target. |
| `PHASE_RPC_URL` | `https://rpc-main.phase.xyz`. Use this endpoint directly to preserve source identity and retention handling. |
| `RPC_CONCURRENCY`, `RPC_TIMEOUT_MS`, `RPC_RETRIES` | `1`, `5000`, `3`. |
| `RPC_BACKOFF_BASE_MS`, `RPC_BACKOFF_MAX_MS` | `500`, `12000`. |
| `COLLECTOR_BATCH_SIZE`, `COLLECTOR_OVERLAP_VIEWS` | `250`, `8`. |
| `COLLECTOR_POLL_MS`, `COLLECTOR_CATCHUP_MS` | `5000`, `750`. |
| `COLLECTOR_RETENTION_PROBE_MS`, `COLLECTOR_OBSERVATION_GAP_MS`, `COLLECTOR_HEAD_MS` | `900000`, `60000`, `30000`. |
| `TEST_DATABASE_URL` | Integration tests only. Leave unset for the soak. Automated tests use their own disposable database. |
| `API_HOST`, `API_PORT` | `127.0.0.1`, `8787`. The soak needs no API process. |
| `POSTGRES_DB`, `POSTGRES_USER`, `POSTGRES_PASSWORD`, `PGPASSWORD` | Used by CI's service and client. Launch the soak with an explicit environment to avoid inheriting local `PG*` values or `NODE_OPTIONS`. |

Required services and tools are the temporary VM, outbound DNS and HTTPS to Phase mainnet, a dedicated PostgreSQL 17 cluster, Node.js and npm, logging and process sampling on the VM, and private off-VM backup storage on the D drive. Package access is a build prerequisite. IAP SSH is the administrative access path.

## Isolated target proposed for review

| Component | Proposed target |
| --- | --- |
| VM and cluster | `phase-datahub-vps`, project `phase-datahub-261127`, zone `asia-south1-a`. New PostgreSQL 17 cluster at `127.0.0.1:55473` with data directory `/var/lib/phase-datahub-soak/m13-1947a1e/pgdata`. |
| Database | New `phase_datahub_soak_m13`, initially empty, with one writer and one Phase source. Treat an occupied port, an existing data directory or a database identity mismatch as a preflight failure. |
| Roles | Separate administrator/migrator, `phase_soak_writer` and `phase_soak_monitor`. The writer can insert archive and occurrence evidence and update source registration, checkpoints, projections and gap rows as needed. The archival body table allows insert and select for the writer. The monitor uses read-only transactions. |
| Off-VM backup and restore | Store verified backups in access-controlled `D:\PhaseDataHub\.local\m13-soak\<run-id>`. Restore to a second, fresh PostgreSQL 17 cluster on the laptop at `127.0.0.1:55474`, database `phase_datahub_soak_m13_restore`. |

After approval, record the VM identity, database name, port, data directory, cluster system identifier, PostgreSQL version, and login role from the appropriate administrative or application connection. Assert the verified identity before migration, launch, restart, sampling, dump and restore. Apply versions 001 and 002 only to the freshly initialized target. Verify the migration checksums, empty application tables and restricted roles. Store credentials outside Git and logs. [Schema migration runner](../../src/schema-migrations.ts#L45)

## Instrumentation and cadence

Use a run-local Node `--import` preloader with the existing collector binary, a process supervisor and a read-only PostgreSQL sampler. Observe fetch attempts, typed method outcomes and the response bytes read by the existing client. Pass through the same request options, byte chunks, errors and cancellation. Verify with saved fixtures that instrumentation adds no RPC calls, preserves responses and does not introduce material polling delays. [Collector entry point](../../src/collector-main.ts) · [Node module preloading](https://nodejs.org/download/release/v24.20.0/docs/api/cli.html#--importmodule)

| Signal | Capture |
| --- | --- |
| Process lifecycle | Run ID, boot ID, invocation/PID, UTC and monotonic times, command or signal, exit code, collector start/stop/fatal events and relevant OOM or host events. Set the run service's restart policy to `no`. |
| Requests and retries | Append one start and one outcome per actual HTTP attempt, keyed by invocation plus original JSON-RPC request ID and attempt ordinal. Record method, cursor or head tag, status, elapsed time and failure kind. Reconcile starts to transport success, failure, shutdown cancellation or unexplained/incomplete records. Separately count envelope success and typed RPC acceptance, including request failures before any transport attempt. Correlate `rpc_error`, `collector_poll_failed`, `retention_probe_failed` and `head_observation_failed`. |
| Original bytes and hashes | Hash complete body bytes read by the collector with SHA-256 before parsing for the audit. Persist the exact fetch-decoded entity bytes in a bounded durable spool with per-attempt metadata and the linked original request text. Preserve references for identical replies. Mark incomplete reads and cancellations explicitly. A non-2xx body the client cancels has monitoring metadata only. |
| Per committed cycle | Keep `collector_page_committed` fields for cursor, high view, wire count, duplicate count and floor. Reconcile against committed pages independently of logs, since a commit can succeed immediately before process exit. |
| Every minute | Record UTC and elapsed time, current checkpoint revision/high view/last success, PostgreSQL database size, process RSS/peak RSS, CPU time and interval utilization, host memory/load and free disk. Keep queries bounded and record any missing sample. |
| Every 15 minutes and at start/stop/restart | Read exact counts and deltas for raw responses by method/purpose, projections, occurrences, indexed/pending/unsupported view responses, active and superseded gaps by state, and collector observation gaps. Use one read-only repeatable-read snapshot for related rows. Record table/index sizes and WAL separately. Copy sealed capture segments and checksum manifests off the VM. |

Treat capture overflow, a lost artifact, or an unexplained open attempt as incomplete evidence. Use a finite capture buffer and a disk warning and safe-stop threshold based on measured guest capacity and growth. For sizing, 96 periodic probes at the historical 3.78 MB capture size add roughly 363 MB of raw body bytes. Leading gaps can trigger probes sooner and catch-up can increase request volume. PostgreSQL occurrence rows, indexes, WAL, capture copies and dump staging need additional capacity. Stop gracefully if the disk threshold is crossed and preserve partial evidence. [Historical capture size](../rpc-evidence.md#verification)

Before mainnet use, compare instrumented and uninstrumented requests, outcomes and stored bytes with identical fixtures. Include successful duplicate records, an empty page, invalid JSON, an application-invalid reply, HTTP 429, a timeout, cancellation during backoff, and a complete reply followed by transaction rollback. Reconcile stored and captured responses as a multiset of method, exact request hash and response hash within each process segment and archive watermark. This accounts for identical bodies and request IDs that repeat across restarts.

## Backup and recovery plan

1. After review, run a backup/restore drill on fresh isolated databases with one empty migrated data set and one fixture-seeded data set. Compare migration checksums, counts, and all fixture response hashes after restore. Take and hash a baseline dump of the actual candidate target while its application tables are empty.
2. Take consistent mid-run and pre-restart snapshots while the collector is running, plus a final snapshot after it exits. Export the repeatable-read snapshot and use it for both the matching row/hash manifest and `pg_dump --format=custom --snapshot=<id>`. Keep the exporter open until the dump imports it. Record each dump's checkpoint, response count, highest response ID and schema checksums. [Consistent dumps](https://www.postgresql.org/docs/17/app-pgdump.html) · [Snapshot synchronization](https://www.postgresql.org/docs/17/functions-admin.html#FUNCTIONS-SNAPSHOT-SYNCHRONIZATION)
3. Copy dumps, logs and raw captures to the D-drive location and verify SHA-256 on both ends. Restore the final backup into the separately verified empty restore target with `pg_restore --exit-on-error --no-owner --no-privileges`. Compare checkpoints, schema, counts, projection references and every archived body hash at that watermark. Finish the off-VM copy and restore verification before the VM's scheduled deletion. [PostgreSQL restore](https://www.postgresql.org/docs/17/app-pgrestore.html)
4. If the process stops, recover on the durable checkpoint of the same isolated database and preserve all existing evidence. In case of database loss, restore the latest verified snapshot to a fresh target. The recovery point is the dump snapshot. Reconcile later replies with sealed raw captures and report any remaining coverage; this plan has no WAL-based point-in-time recovery. Preserve, rather than reset, failed run artifacts.

## Proposed run and acceptance

Measure **24 uninterrupted hours in the first collector invocation**, beginning once identity is established and the first valid page commits. Immediately afterward, do the controlled restart on the same database and measure it as a separate recovery segment. Duration comes from the monotonic clock, with UTC timestamps for audit and IST for reporting. An unexpected stop during the 24-hour interval makes the attempt incomplete. Record its cause and any explicitly initiated recovery segment.

At the end of the continuous window, signal SIGTERM and wait for the process to exit. Save the settled revision, high view, source ID and raw response watermark. Restart the same build and verify the first request cursor, first successful commit, unchanged source ID and nondecreasing high view. Check all pre-restart response IDs and hashes against their capture ledger. Record downtime and time to recovery. Verify that newly returned views advance the high view when available, and distinguish an empty successful poll from demonstrated progress.

| Acceptance | Required result |
| --- | --- |
| Uptime and request counts | One verified 24-hour invocation, observed interruption details and exact request totals. Reconcile successful, failed, retried, timed out and cancelled attempts with the raw ledger. |
| Checkpoint and restart | Revisions reconcile with winning commits. High views never decrease. Restart begins at the persisted cursor with expected overlap, then commits without losing pre-restart evidence. |
| Storage and evidence | Raw body/hash match across capture, archive and restored backup. Replay committed view bodies with `decodeArchivedViewOccurrences` and compare every offset, repeat, normalized record and index outcome. Verify that each current occurrence belongs to the same source and view and matches the projected record. Report valid but uncommitted replies and any pending or unsupported responses. |
| Gaps and resources | Check unexplained numeric holes against active gap ranges and their raw evidence. Keep source omissions, source retention and collector observation gaps separate. Report database, WAL, capture and resource growth with baseline, end and peak values. |
| Reporting | Record exact timestamps, uptime, database identity, request/failure counts, checkpoints, archive and occurrence totals, gap and integrity findings, storage and resource measurements, restart evidence and open issues in `docs/audit/M1_3_SOAK_COMPLETION_REPORT.md` after the run. Use `incomplete` if the continuous window or required verification is unfinished. |

The gap and integrity results apply to observations from the configured source. A source-level gap does not establish a protocol-level failure, and a single source does not establish independent consensus verification.

**Review gate.** Approve the isolated database and restore target, off-VM backup plan, and the proposed sequencing of a controlled restart immediately after the 24-hour continuous window. The soak remains pending.
