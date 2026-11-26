# Phase DataHub

Phase DataHub archives consensus views from Phase mainnet. The collector preserves the original RPC responses in PostgreSQL and keeps a queryable view of the latest records, along with the gaps it observes.

## Run locally

Use Node.js 22.12 or newer and a PostgreSQL database. Set `DATABASE_URL` to the database connection URL in your shell, then run the setup commands.

```sh
npm ci
npm run build
npm run db:migrate
```

Run `npm run collector` and `npm run api` in separate terminals with the same database URL. Query the API once both are running.

```sh
curl 'http://127.0.0.1:8787/v1/consensus/views?limit=20'
```

On Windows PowerShell, use `npm.cmd` and `curl.exe` if needed.

## Query views

`GET /v1/consensus/views` returns views in descending ID order. The default limit is 20, with a maximum of 100. IDs, heights, and other uint64 values are decimal strings.

| Field | Contents |
| --- | --- |
| `views` | Consensus records with observation timestamps and references to the original RPC responses. |
| `blockHeads` | The source's separate `latest` and `finalized` blocks. |
| `coverage` | Indexed range, last successful poll, retention boundary and recent gaps. |
| `source` | The RPC endpoint and the chain identity checked at collector startup. |

A sequence gap is recorded as a candidate until the source returns enough data to mark it unrecoverable from that source or fill it. Block finality is reported by the RPC endpoint. See the [collector and database notes](docs/operations.md) and the [captured RPC evidence](docs/rpc-evidence.md).

## Run tests

Set `TEST_DATABASE_URL` to a separate PostgreSQL database. The test role needs permission to create schemas there. Run `npm test` for the full suite or `npm run test:unit` for the RPC client tests.
