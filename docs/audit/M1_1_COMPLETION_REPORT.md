# M1.1 completion and validation report

Validation date 27 November 2026 (IST). Reviewed release `d33fc47b7869e29cfb1f979e891a215d8ee16423`.

## Branch and release state

The active local branch was `main`, and the working tree was clean before the two audit reports were added. Local `main`, the `origin/main` tracking ref, the local HEAD and GitHub's default branch all pointed to the reviewed SHA. GitHub advertised only `refs/heads/main`. Neither the local checkout nor GitHub had a `master` branch, so a `main` to `master` comparison has no second ref. The newest M1.1 implementation is on `main`. [Reviewed commit](https://github.com/omkar150p/phase-datahub/commit/d33fc47b7869e29cfb1f979e891a215d8ee16423)

The `Tests` workflow runs on pushes to `main` and on pull requests. It has no path filter. The reviewed implementation commit's push run passed. This audit's requested GitHub update consists of the two reports in a normal forward commit on the existing branch. [Workflow trigger](https://github.com/omkar150p/phase-datahub/blob/d33fc47b7869e29cfb1f979e891a215d8ee16423/.github/workflows/tests.yml#L1-L14) · [Implementation CI run](https://github.com/omkar150p/phase-datahub/actions/runs/45953316731)

## Implemented and verified in code

| Check | Result and evidence |
| --- | --- |
| All committed occurrences and original offsets | The decoder assigns zero-based `result[]` positions before sorting and projection. Ordinary pages, retention probes and superseded polls pass the full occurrence array to the archive transaction. The primary key is `(response_id, response_index)`, and the response relationship carries the source ID. A valid empty response records an indexed result of zero. [Decoder](https://github.com/omkar150p/phase-datahub/blob/d33fc47b7869e29cfb1f979e891a215d8ee16423/src/phase-rpc.ts#L124-L179) · [Collector](https://github.com/omkar150p/phase-datahub/blob/d33fc47b7869e29cfb1f979e891a215d8ee16423/src/collector.ts#L33-L74) · [Poll paths](https://github.com/omkar150p/phase-datahub/blob/d33fc47b7869e29cfb1f979e891a215d8ee16423/src/database.ts#L228-L256) · [Schema](https://github.com/omkar150p/phase-datahub/blob/d33fc47b7869e29cfb1f979e891a215d8ee16423/db/002_observation_integrity.sql#L1-L35) |
| Deterministic normalization and compatible projection | The decoder uses exact decimal strings and preserves wire list order. For fixed input, the representative uses certificate rank, source timestamp and the later input position for a tie. Across writes, the database preserves the existing rank/time rules and points to a selected occurrence when available. Legacy pointers can have a null offset. No canonical certificate claim is made by this projection. [Decoder](https://github.com/omkar150p/phase-datahub/blob/d33fc47b7869e29cfb1f979e891a215d8ee16423/src/phase-rpc.ts#L124-L179) · [Projection](https://github.com/omkar150p/phase-datahub/blob/d33fc47b7869e29cfb1f979e891a215d8ee16423/src/database.ts#L98-L144) · [Offset foreign key](https://github.com/omkar150p/phase-datahub/blob/d33fc47b7869e29cfb1f979e891a215d8ee16423/db/002_observation_integrity.sql#L38-L42) |
| Restartable, idempotent backfill | The batch tool scans archived view responses without a result ledger entry. It locks one response at a time with `SKIP LOCKED`, checks for a result again after acquiring the row, and commits each response independently. Replay uses an idempotent occurrence key and verifies indexed content before it records success. The limit is 1–100 responses per invocation. [Backfill](https://github.com/omkar150p/phase-datahub/blob/d33fc47b7869e29cfb1f979e891a215d8ee16423/src/observation-tools.ts#L15-L49) · [Replay equality and result ledger](https://github.com/omkar150p/phase-datahub/blob/d33fc47b7869e29cfb1f979e891a215d8ee16423/src/observation-index.ts#L6-L47) |
| Unsupported historical responses | A historical parse/validation failure is recorded with an unsupported outcome and error reason. Original response bytes remain in the archive. Database write failures propagate and roll back. The internal CLI exposes backfill and read-only inspection as separate commands. [Archived decoding](https://github.com/omkar150p/phase-datahub/blob/d33fc47b7869e29cfb1f979e891a215d8ee16423/src/phase-rpc.ts#L181-L198) · [Backfill](https://github.com/omkar150p/phase-datahub/blob/d33fc47b7869e29cfb1f979e891a215d8ee16423/src/observation-tools.ts#L25-L49) · [Outcome storage](https://github.com/omkar150p/phase-datahub/blob/d33fc47b7869e29cfb1f979e891a215d8ee16423/src/observation-index.ts#L49-L57) · [CLI](https://github.com/omkar150p/phase-datahub/blob/d33fc47b7869e29cfb1f979e891a215d8ee16423/src/observations-main.ts#L1-L25) |
| Raw bytes and atomic checkpoint | The same PostgreSQL transaction writes the raw body, occurrence rows, index result, projections, gaps and checkpoint for a winning poll. The checkpoint row is locked before the write. A superseded poll keeps evidence without advancing the cursor. The rollback tests and local backup comparison verify this behavior. [Transaction and archive writes](https://github.com/omkar150p/phase-datahub/blob/d33fc47b7869e29cfb1f979e891a215d8ee16423/src/database.ts#L38-L81) · [Poll transaction](https://github.com/omkar150p/phase-datahub/blob/d33fc47b7869e29cfb1f979e891a215d8ee16423/src/database.ts#L228-L298) |
| Scoped discrepancy findings | Inspection is scoped to a source and view and reads a bounded set in a repeatable-read transaction. Comparison separates signer ordering, membership/count differences, conflicting hashes and certificate transitions. `unresolved` is a recorded source discrepancy. [Comparison](https://github.com/omkar150p/phase-datahub/blob/d33fc47b7869e29cfb1f979e891a215d8ee16423/src/observation-findings.ts#L36-L127) · [Inspection](https://github.com/omkar150p/phase-datahub/blob/d33fc47b7869e29cfb1f979e891a215d8ee16423/src/observation-tools.ts#L51-L93) |
| Migrations | The runner takes an advisory lock, checks the original shape for unversioned databases, and matches applied names and SHA-256 checksums. The migration and ledger changes share a transaction. [Migration code](https://github.com/omkar150p/phase-datahub/blob/d33fc47b7869e29cfb1f979e891a215d8ee16423/src/schema-migrations.ts#L42-L82) · [Migration transaction](https://github.com/omkar150p/phase-datahub/blob/d33fc47b7869e29cfb1f979e891a215d8ee16423/src/database.ts#L38-L62) |

## Tested

Ran `npm ci`, `npm run build` and `npm test` under Node.js 24.22.3. The test process had only `TEST_DATABASE_URL`, pointed at a newly initialized loopback PostgreSQL 17.12 cluster and an empty validation test database. The existing archive and configured test database were separate. The fresh test cluster was stopped after the suite. An earlier setup attempt halted before application tests because the Windows launcher exposed the removed archive variable as an empty string. The final launcher explicitly cleared it and checked that the test process had no archive URL.

| Area | Automated evidence |
| --- | --- |
| Fresh migration | The integration setup applies the migrations to an empty scratch schema. A separate checksum case also starts from a fresh upgrade schema. [Fresh setup](https://github.com/omkar150p/phase-datahub/blob/d33fc47b7869e29cfb1f979e891a215d8ee16423/test/collector.integration.test.ts#L26-L38) · [Checksum case](https://github.com/omkar150p/phase-datahub/blob/d33fc47b7869e29cfb1f979e891a215d8ee16423/test/collector.integration.test.ts#L126-L139) |
| Populated legacy upgrade and concurrency | A legacy schema receives raw data, a projection and a checkpoint. Two concurrent attempts apply both migrations once, and the test checks that legacy state survives. [Upgrade test](https://github.com/omkar150p/phase-datahub/blob/d33fc47b7869e29cfb1f979e891a215d8ee16423/test/collector.integration.test.ts#L84-L124) |
| Drift, checksum and rollback | Missing legacy index and changed ledger checksum are rejected. Failed DDL, failed occurrence/consensus inserts and a late checkpoint failure are rolled back. [Migration failures](https://github.com/omkar150p/phase-datahub/blob/d33fc47b7869e29cfb1f979e891a215d8ee16423/test/collector.integration.test.ts#L126-L148) · [Occurrence failure](https://github.com/omkar150p/phase-datahub/blob/d33fc47b7869e29cfb1f979e891a215d8ee16423/test/collector.integration.test.ts#L177-L199) · [Write rollback](https://github.com/omkar150p/phase-datahub/blob/d33fc47b7869e29cfb1f979e891a215d8ee16423/test/collector.integration.test.ts#L324-L373) |
| Occurrence and signer comparison | Out-of-order real fixtures keep all offsets. Comparison tests distinguish identical entries, permutations, signer differences and conflicting hashes or certificate order. Probe and superseded poll tests confirm both evidence paths. [Occurrence assertions](https://github.com/omkar150p/phase-datahub/blob/d33fc47b7869e29cfb1f979e891a215d8ee16423/test/collector.integration.test.ts#L150-L175) · [Comparison assertions](https://github.com/omkar150p/phase-datahub/blob/d33fc47b7869e29cfb1f979e891a215d8ee16423/test/rpc.test.ts#L18-L52) · [Probe cases](https://github.com/omkar150p/phase-datahub/blob/d33fc47b7869e29cfb1f979e891a215d8ee16423/test/collector.integration.test.ts#L445-L490) · [Superseded poll](https://github.com/omkar150p/phase-datahub/blob/d33fc47b7869e29cfb1f979e891a215d8ee16423/test/collector.integration.test.ts#L639-L659) |
| Backfill | Bounded replay, concurrent workers, empty and unsupported responses, no-op reruns and conflicting pre-existing rows are covered. [Backfill tests](https://github.com/omkar150p/phase-datahub/blob/d33fc47b7869e29cfb1f979e891a215d8ee16423/test/collector.integration.test.ts#L201-L264) |
| Projection and API | Existing list and limit behavior, source-reported heads, uint64 precision, restart and tentative-to-full projection are covered. [Projection test](https://github.com/omkar150p/phase-datahub/blob/d33fc47b7869e29cfb1f979e891a215d8ee16423/test/collector.integration.test.ts#L288-L322) · [API tests](https://github.com/omkar150p/phase-datahub/blob/d33fc47b7869e29cfb1f979e891a215d8ee16423/test/collector.integration.test.ts#L547-L637) |

The fresh run passed all 39 tests with zero failures or skips. The automated tests exercise local PostgreSQL and mocked RPC endpoints, including replay of saved mainnet payloads. Their results establish application behavior under the cases tested. The live evidence below has a separate scope.

## Live verified

### Current public RPC

The published client completed a small read-only call to Phase mainnet on 27 November 2026 at `09:11:25.113Z` (14:41 IST). `getIdentity()` verified chain ID `1015` and the configured genesis. `phase_getViewRecords([null, 3])` returned 1,121 bytes and three retained views in wire order `8464126`, `8464125`, `8464127`. Their preserved occurrence offsets were 0, 1 and 2. This smoke check covers live connectivity, identity and decoding. It wrote nothing to the archive. [RPC client](https://github.com/omkar150p/phase-datahub/blob/d33fc47b7869e29cfb1f979e891a215d8ee16423/src/phase-rpc.ts#L259-L293)

### Existing local archive and backup comparison

Connected to the configured loopback archive `phase_datahub` on port 55432 using read-only PostgreSQL transactions. Confirmed server `17.12` and the read-only setting before inspection. Migration versions 1 and 2 were already recorded. The configured test connection was identified by database name only. Connection strings and credentials are excluded.

| Source ID | Endpoint | Archived view responses | Indexed | Unsupported | Pending | Occurrences | Representative views |
| ---: | --- | ---: | ---: | ---: | ---: | ---: | ---: |
| 1 | `https://rpc-main.phase.xyz` | 4 | 4 | 0 | 0 | 10,180 | 163 |

The archived response IDs `5`, `8`, `13` and `14` contained 60, 60, 60 and 10,000 occurrences. Each stored zero-based offset, view ID and normalized record matched the corresponding raw entry and a replay of the archived request. The archive's observation range was `8294923–8304736`. The complete database contained 14 raw responses, including non-view RPC methods.

Compared the existing archive to the pre-M1.1 database copy using read-only queries. All 14 raw response SHA-256 digests and request texts matched. The 163 representative rows matched after excluding the newly introduced occurrence-index column. The checkpoint, view gap and collection-gap records also matched. Treat the copy as evidence for this verified snapshot and recheck any backup against a future write target. No migration, backfill or data modification was performed on the existing database in this audit.

### Requested sample views

The internal read-only inspection returned `unknown` with zero occurrences for all three IDs in local source 1. The actual captured mainnet responses below remain available in the repository. All 12 repository capture SHA-256 values were checked, and repeated decoding of each view capture produced equal normalized occurrences.

| View ID | Capture and wire offsets | Observed difference | Result on fixture evidence |
| --- | --- | --- | --- |
| `8294199` | `live-order-11.json`, 20 and 22 | Same block hash and full status. Signer index 220 disappears and count changes 10 → 9. Source timestamps are `1795712685` and `1795712686`. | `unresolved` |
| `8294232` | `live-order-11.json`, 53 and 55 | Same block hash, full status and timestamp `1795712698`. Signer index 185 appears and count changes 10 → 11. | `unresolved` |
| `8294794` | `live-order-12.json`, 14 and 16 | Same block hash, full status and timestamp `1795712882`. Signer index 218 disappears and count changes 10 → 9. | `unresolved` |

These are signer membership and reported-count variations from one source. The fixture numbers identify RPC captures and array positions, and the local archive has no corresponding response references for these views. [First saved response](https://github.com/omkar150p/phase-datahub/blob/d33fc47b7869e29cfb1f979e891a215d8ee16423/fixtures/phase-mainnet/live-order-11.json#L1) · [Second saved response](https://github.com/omkar150p/phase-datahub/blob/d33fc47b7869e29cfb1f979e891a215d8ee16423/fixtures/phase-mainnet/live-order-12.json#L1) · [Fixture manifest](https://github.com/omkar150p/phase-datahub/blob/d33fc47b7869e29cfb1f979e891a215d8ee16423/fixtures/phase-mainnet/manifest.json)

## Pending and safe backfill procedure

The inspected archive has zero pending responses. Future backfill should start only after the owner explicitly confirms the named target is development/test and the operator verifies a restorable backup for that target. Quiesce archive writes for the backup and reconcile the ledger after any other backfill worker has finished. The following PowerShell commands describe the previously identified local target. They were prepared for review and the write command was not executed in this audit.

```powershell
Set-Location -LiteralPath 'D:\PhaseDataHub'
$phaseRuntime = (Get-Content -LiteralPath '.local\node\runtime-path.txt' -Raw).Trim()
$env:Path = "$phaseRuntime;$env:Path"
$phaseConfig = Get-Content -LiteralPath '.local\postgres\connection.json' -Raw | ConvertFrom-Json
$phaseTarget = [uri]$phaseConfig.databaseUrl
if ($phaseTarget.Host -ne '127.0.0.1' -or $phaseTarget.Port -ne 55432 -or
    $phaseTarget.AbsolutePath -ne '/phase_datahub') { throw 'Unexpected archive target' }
if ((Read-Host 'After independently verifying the backup, enter BACKFILL phase_datahub if the owner approved this development database') -cne 'BACKFILL phase_datahub') {
  throw 'Backfill target was not approved'
}
$env:DATABASE_URL = $phaseConfig.databaseUrl
npm.cmd run build
if ($LASTEXITCODE -ne 0) { throw 'Build failed' }
@'
import assert from "node:assert/strict";
import pg from "pg";
const c = new pg.Client({
  connectionString: process.env.DATABASE_URL,
  options: "-c default_transaction_read_only=on",
});
await c.connect();
try {
  const { rows: [target] } = await c.query(
    "SELECT current_database() AS name, inet_server_port() AS port, " +
    "current_setting('transaction_read_only') AS mode"
  );
  assert.deepEqual(target, { name: "phase_datahub", port: 55432, mode: "on" });
  const versions = await c.query("SELECT version FROM schema_migrations ORDER BY version");
  assert.deepEqual(versions.rows.map(({ version }) => version), [1, 2]);
  console.log("Archive identity and migration ledger verified read-only.");
} finally {
  await c.end();
}
'@ | node.exe --input-type=module -
if ($LASTEXITCODE -ne 0) { throw 'Read-only archive preflight failed' }
npm.cmd run db:backfill-observations -- 25
if ($LASTEXITCODE -ne 0) { throw 'Backfill batch failed' }
```

Repeat the explicit 25-response batch after reviewing the preceding output. If a batch reports zero indexed and unsupported results, verify the pending count read-only at the same checked target. A zero batch alone can occur while other workers hold locks. Review unsupported outcomes before claiming complete materialization.

```sql
SELECT s.id AS source_id,
       count(r.id) AS archived_view_responses,
       count(r.id) FILTER (WHERE i.outcome = 'indexed') AS indexed,
       count(r.id) FILTER (WHERE i.outcome = 'unsupported') AS unsupported,
       count(r.id) FILTER (WHERE i.response_id IS NULL) AS pending
FROM sources s
LEFT JOIN rpc_responses r
  ON r.source_id = s.id AND r.method = 'phase_getViewRecords'
LEFT JOIN observation_index_results i ON i.response_id = r.id
GROUP BY s.id
ORDER BY s.id;
```

Human review of the [M1.2 historical API scope](NEXT_MILESTONE_PLAN.md) is pending. No historical routes were implemented. A 24-hour live collector soak, live ingest durability under sustained load and external deployment readiness remain open.

## Known risks

- A single read-only RPC smoke check and prior archived captures provide bounded source evidence. They leave sustained coverage, network-wide agreement and finality verification open.
- Parsing or transaction failure can leave a reply outside the committed evidence set. Observation integrity describes archived successes and explicitly recorded replay outcomes.
- Internal inspection samples at most 1,000 occurrences for a view. Truncated and unsupported coverage can hide additional discrepancies. Recheck the API scope and latency before exposing the summary.
- Per-occurrence rows and indexes amplify storage and writes. The 24-hour soak will measure growth and checkpoint behavior. Migration validation was exercised on PostgreSQL 17.12 and uses the current catalog shape for baseline adoption.

## Exact command output

<details>
<summary>Clean install, standalone build and automated test run</summary>

```text
$ npm ci

added 68 packages, and audited 69 packages in 3s

21 packages are looking for funding
  run `npm fund` for details

found 0 vulnerabilities
$ npm run build

> phase-datahub@0.1.0 build
> tsc -p tsconfig.json

$ npm test

> phase-datahub@0.1.0 test
> npm run build && node --test dist/test/rpc.test.js dist/test/collector.integration.test.js


> phase-datahub@0.1.0 build
> tsc -p tsconfig.json

✔ versioned migrations adopt a populated original schema and serialize concurrent upgrades (412.3661ms)
✔ unexpected legacy indexes and changed migration checksums are rejected (234.2294ms)
✔ a failed migration rolls back the baseline DDL and version ledger (133.1459ms)
✔ real repeated responses retain all wire offsets with one compatible projection per view (151.197ms)
✔ an occurrence write failure rolls back raw evidence, projection and checkpoint (59.2001ms)
✔ bounded backfill recovers empty responses, retains unsupported bodies, and resumes without duplicates (115.5926ms)
✔ backfill verifies existing occurrence contents before recording completion (62.5577ms)
✔ repeated batches keep one projection per view and preserve each raw response (48.867ms)
✔ tentative-to-full updates the same view while preserving original bytes and ignoring a regression (48.729ms)
✔ a failed consensus insert never advances the checkpoint (53.3404ms)
✔ a late checkpoint failure rolls back the raw batch, inserted view, and new gap (102.8033ms)
✔ restart loads the durable cursor and catches up through overlapping pages without duplicates (59.7128ms)
✔ view IDs drive candidate gaps, independent of block heights and view timestamps (63.4138ms)
✔ retention exhaustion records only the prefix below an evidenced floor as unrecoverable (58.0986ms)
✔ a full page from a custom endpoint does not establish the retention floor (1150.4272ms)
✔ a retention-window probe restores a candidate that has moved outside the overlap (60.2812ms)
✔ the collector bypasses overlap once when repeated wire observations fill a page without progress (58.5018ms)
✔ an empty retention probe confirms no source floor and leaves gaps as candidates (63.3241ms)
✔ an empty page preserves the high cursor and records successful observation without inventing a view gap (45.837ms)
✔ PostgreSQL stores and reuses uint64 cursors without precision loss (42.5157ms)
✔ latest and finalized block heads are distinct source observations (38.243ms)
✔ API returns at most 20 newest views, source, coverage, and separate finality (174.8511ms)
✔ API handles default and empty results and rejects invalid limits (31.7612ms)
✔ overlapping collector instances serialize the checkpoint and preserve superseded evidence (172.802ms)
✔ comparison distinguishes identical facts, permutations and actual signer discrepancies (5.4323ms)
✔ comparison scopes committee context, block hashes and certificate ordering (1.7296ms)
✔ captured RPC responses match their manifest (3.596ms)
✔ decodes byte-for-byte live Phase view fixture with independent signer fields (56.0113ms)
✔ signer count and array are preserved independently when the source disagrees (13.7364ms)
✔ empty JSON-RPC result is a valid page (6.9849ms)
✔ uint64 view IDs are sent as exact JSON numbers and normalized as decimal strings (8.924ms)
✔ the two captured live pages preserve repeated wire records and project one ordered view each (23.8742ms)
✔ malformed or cursor-inconsistent pages are rejected (14.1216ms)
✔ wrong genesis is rejected even when the chain ID matches (11.9856ms)
✔ RPC timeout retries within the configured budget and produces structured logs (242.7334ms)
✔ HTTP 429 and Phase server-busy errors use retry handling (1068.1033ms)
✔ an oversized response is rejected before its body is buffered (10.0172ms)
✔ configured concurrency bounds simultaneous requests (144.2742ms)
✔ graceful abort cancels in-flight RPC without retries (6.1901ms)
ℹ tests 39
ℹ suites 0
ℹ pass 39
ℹ fail 0
ℹ cancelled 0
ℹ skipped 0
ℹ todo 0
ℹ duration_ms 3784.9676
```

</details>

## Decision

M1.1 is suitable for review. M1.2 implementation requires human approval of the route contracts, coverage semantics and integrity payload. The sustained live soak remains a release validation item.

**CONDITIONAL GO**
