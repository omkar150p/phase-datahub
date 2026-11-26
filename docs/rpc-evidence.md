# Phase DataHub M0 RPC evidence

`fixtures/phase-mainnet/manifest.json` records the endpoint, request, receipt time, status and corresponding byte-for-byte response files. The fixtures were captured directly from the Phase mainnet HTTPS endpoint.

| Request | Observed result |
| --- | --- |
| `eth_chainId([])` | `0x3f7`, or 1015. |
| `eth_getBlockByNumber(["0x0", false])` | Genesis hash `0x50b453b2fc402366a4341b111cd63539676277199c34339f07a10e73f964e2f7`. |
| `phase_getViewRecords([null, 3])` | First retained record in that response was view `8289619`. |
| `phase_getViewRecords([8289719, 3])` | `8289719, 8289720, 8289721` in ascending order. |
| `phase_getViewRecords([8289720, 2])` | `8289720, 8289721`. The cursor was inclusive. |
| `phase_getViewRecords([8289722, 2])` | `8289722, 8289723`. The next page starts at prior last ID plus one. |
| `phase_getViewRecords([8279619, 1])` | Returned `8289624` without a retention error. The earliest served ID had moved forward. |
| `phase_getViewRecords([9000000000000, 1])` | Successful JSON-RPC response with `result: []`. |
| `eth_getBlockByNumber(["latest", false])` | Source-reported height `0x7e6a25`. |
| `eth_getBlockByNumber(["finalized", false])` | Source-reported height `0x7e6a23` in the following request. |

Two later 60-entry mainnet pages repeated view IDs out of numeric order. The default-cursor page returned views 8294199, 8294200, 8294199 in that wire order. The second 8294199 observation kept the same block hash and changed the signer data. The explicit range from 8294779 contained four repeated IDs. Both raw pages are in the fixture manifest.

The overlapping samples returned the same view IDs across requests. The RPC documents one view number per record and shows only the upgraded state after a tentative certificate becomes full. DataHub uses the verified source identity and the wire field `view` as its key. It preserves the wire fields `timestamp_secs`, `block_height`, `success`, `is_tentative`, `signer_count` and `signers` as distinct observations.

The reference documents oldest-first results, the default 10,000-view memory window, records omitted during node catch-up, and the difference between source-reported `latest` and `finalized`. The collector sorts the projected IDs, retains wire order in raw evidence and calculates the source floor from the minimum ID of a full-window probe when needed. Automated tests use the saved live shapes and simulate a certificate transition, expired history, disconnections and write failures. [Phase RPC reference](https://phase.xyz/docs/rpc/).

## Verification

- A clean dependency install and the TypeScript build passed on Node.js 24.22.3. The integration suite ran against PostgreSQL 17.12 in an isolated test schema.
- A live two-page smoke test persisted 108 distinct projections across a collector restart. The checkpoint moved from 8294976 to 8295030. The actual local HTTP endpoint returned 200 and 20 records. The response included source-reported latest block 8290013 and finalized block 8290011.
- A separate live `[null, 10000]` probe returned 3,781,141 bytes and 10,000 wire entries. These reduced to 9,568 unique view IDs, including 432 repeated observations. The minimum returned ID was 8295032. After projection the response contained 9,567 full certificate observations and one record with no certificate. The full-window capture was kept with the local test data.
- After the live source rolled beyond checkpoint 8295030, the collector resumed at 8295207. The HTTP API reported gap 8295031–8295152 as `unrecoverable_from_source`, a sampled floor of 8295157, and one collector observation gap. The database linked the interval to its 3,780,822-byte raw retention response. The observed page had already provided views below the later probe floor, and those saved views were excluded from the unrecoverable interval. The run recovered from one RPC timeout.
- The repository review added coverage for oversized RPC bodies and truncated retention probes on custom endpoints. All 29 tests passed.
