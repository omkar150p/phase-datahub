# Phase DataHub

Phase DataHub archives consensus views from Phase mainnet and serves the latest indexed views, observed block heads, and coverage gaps over HTTP.

## Run locally

Use Node.js 22.12 or newer and a running PostgreSQL instance. Create a database for the archive and a separate database for integration tests. The test role needs permission to create schemas in the test database.

Set `DATABASE_URL` to the archive connection string and `TEST_DATABASE_URL` to the test connection string in your shell.

```sh
npm ci
npm test
npm run db:migrate
```

For a runtime-only setup, run `npm run build` before `npm run db:migrate`.

With `DATABASE_URL` set in both shells, run `npm run collector` in one and `npm run api` in the other. Stop either with Ctrl+C.

```sh
curl 'http://127.0.0.1:8787/v1/consensus/views?limit=20'
```

On Windows PowerShell, use `npm.cmd` and `curl.exe` if the shell resolves those commands differently.

The API defaults to 20 views and accepts 1–100. It returns newest view ID first. Integers from Phase are represented as decimal strings so callers can preserve uint64 values. The top-level `source` describes the verified chain identity and the reporting endpoint. `blockHeads.latest` and `blockHeads.finalized` are sampled separately from consensus certificates. The `coverage` object includes the first and highest indexed IDs, last successful poll, sampled retention floor and recent gaps. Each of the two gap lists is capped at 20 and has a flag for further entries.

## Storage and recovery

| Table | Contents |
| --- | --- |
| `sources` | Endpoint, Phase chain ID and genesis hash, checked on each collector startup. |
| `rpc_responses` | Append-only records with request text, exact successful response bytes, RPC method, source, receipt time and ingest time. |
| `consensus_views` | Current normalized projection, keyed by source and view ID. Stores separate view timestamp, block height, projected certificate state, first/latest observation times, modification time, first ingestion time and links to raw evidence. |
| `collector_checkpoints` | Last committed high view, last successful poll, revision and most recent non-empty retention-floor evidence. |
| `view_gaps` | Missing-ID interval candidates and intervals below an observed source floor. New evidence can supersede a record and split or close the interval. Superseded records remain available. |
| `collector_observation_gaps` | Intervals between successful collector observations that exceed the configured threshold. |
| `block_head_observations` | Separate source-reported `latest` and `finalized` block observations, with raw response links. |

A poll locks its source checkpoint row. It inserts the raw response, upserts views, reconciles gaps and advances the checkpoint in one PostgreSQL transaction. A concurrent poll that loses the checkpoint race archives its raw response as superseded. A restart re-reads the configured overlap and resumes from the committed high view. A newly observed full certificate updates the same record and both observations remain in raw evidence. Live pages can repeat view IDs out of numeric order. The projection prefers a full certificate, then a tentative certificate, then a record with neither. Within the same state it prefers the newer node timestamp and uses later wire order to break ties within a page. Pagination uses the wire count, including duplicates.

The collector creates a sequence-gap candidate only from an ID discontinuity. View timestamps and block heights are separate observations. It labels a missing interval `unrecoverable_from_source` only for the portion below the minimum returned ID in a successful `[null, 10000]` probe. This covers the public endpoint's documented default window. A custom endpoint that fills the probe limit leaves the lower bound uncertain, so its gaps stay candidates. A probe can repair previously missed IDs through the current checkpoint. That label applies to the answering source at the recorded time. The RPC can omit records, so source gaps stay unconfirmed at the protocol level. An empty probe establishes no retention floor. Coverage starts with the first saved result.

## Configuration

| Variable | Default |
| --- | --- |
| `DATABASE_URL`, `TEST_DATABASE_URL` | Required for the runtime and integration tests respectively |
| `PHASE_RPC_URL` | `https://rpc-main.phase.xyz` |
| `RPC_CONCURRENCY`, `RPC_TIMEOUT_MS`, `RPC_RETRIES` | `1`, `5000`, `3` |
| `RPC_BACKOFF_BASE_MS`, `RPC_BACKOFF_MAX_MS` | `500`, `12000` |
| `COLLECTOR_BATCH_SIZE`, `COLLECTOR_OVERLAP_VIEWS` | `250`, `8` |
| `COLLECTOR_POLL_MS`, `COLLECTOR_CATCHUP_MS` | `5000`, `750` |
| `COLLECTOR_RETENTION_PROBE_MS`, `COLLECTOR_OBSERVATION_GAP_MS` | `900000`, `60000` |
| `COLLECTOR_HEAD_MS` | `30000` |
| `API_HOST`, `API_PORT` | `127.0.0.1`, `8787` |

## Limits

The public Phase RPC is one source of observations. The archive starts within its available window. Normal polling rechecks the configured overlap. Gap-triggered window probes can recover older observations while the source retains them. A late change outside the overlap can be missed between probes. A database outage can prevent otherwise valid responses from being committed. Recovery then depends on what is still available from the upstream. Repeated observations are stored in the raw evidence table, so operating a long-lived archive will require sizing and an evidence retention policy. A 24-hour live collection test and public deployment remain separate release work.

See [M0 RPC evidence](docs/rpc-evidence.md) and the [Phase RPC reference](https://phase.xyz/docs/rpc/).
