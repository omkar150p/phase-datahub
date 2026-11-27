# M1.3 read-only preflight findings

27 November 2026, approximately 23:23–23:26 IST (17:53–17:56 UTC). **Preflight complete. Soak readiness is blocked pending review.**

Verified against the published [M1.3 preparation report](https://github.com/omkar150p/phase-datahub/blob/71a8afb351cb009d3b2afc1bcef677677f75df4e/docs/audit/M1_3_SOAK_PREPARATION_REPORT.md). The published contents matched the Git blob for that commit. The proposed guest target is `127.0.0.1:55473/phase_datahub_soak_m13` on `phase-datahub-vps`.

## Results

| Check | Result | Evidence |
| --- | --- | --- |
| 1. Source commit and working tree | **PASS** | Local `main` and GitHub `main` both pointed to `71a8afb351cb009d3b2afc1bcef677677f75df4e`. The working tree was clean before this report. Compared with the approved application baseline `1947a1e9f3328a235295a57fcad86cf92b1193d7`, HEAD adds only the preparation report. The source, migration and build inputs match. The last commit touching the collector entry point, collector, database or RPC implementation was `d33fc47b7869e29cfb1f979e891a215d8ee16423`. |
| 2. VM identity, zone, machine and disk | **PASS** | `phase-datahub-vps`, instance ID `6313188408716165358`, project `phase-datahub-261127`, Mumbai `asia-south1-a`. Status `RUNNING`, machine `e2-medium`. One x86-64 boot disk named `phase-datahub-vps`, `pd-balanced`, 30 GiB, `READY`, with boot-disk auto-delete enabled. |
| 2. Scheduled VM deletion | **PASS** | Compute Engine reports configured action `DELETE` and an effective termination timestamp of **21 December 2026 at 23:00 IST** (`17:30:00Z`). The pending backup Cloud Task targets the same VM with method `DELETE` at **23:05 IST** (`17:35:00Z`) and has zero dispatches. |
| 3. Guest OS and CPU | **PASS** | Ubuntu 24.04.5 LTS, kernel `7.0.0-1018-gcp`, `x86_64`, 2 online CPUs. Load averages were `0.08 / 0.02 / 0.01` at observation. |
| 3. Guest free disk, inodes and memory | **PASS** | `/` and `/var/lib` use the same root filesystem. Free space was 27,632,828,416 bytes (**25.74 GiB**) with 9% used. **3,710,412** inodes were free out of 3,801,088. Guest memory was **3.82 GiB total**, **3.39 GiB available**, with no swap. |
| 4. PostgreSQL processes, listeners and standard cluster paths | **PASS** | No PostgreSQL server processes or PostgreSQL UNIX sockets were visible in the guest. The standard `/etc/postgresql` and `/var/lib/postgresql` paths were absent. The TCP listener inventory showed only local DNS at port 53 and SSH at port 22. |
| 4. Cluster enumeration beyond standard paths | **NOT VERIFIED** | The packaged cluster listing tool `pg_lsclusters` was unavailable. The filesystem check covered the standard paths and the proposed target. |
| 5. Guest TCP port 55473 | **PASS** | A socket query for TCP local port `55473` succeeded and returned no sockets. Availability is a point-in-time observation. |
| 6. Proposed data directory | **PASS** | `/var/lib` was accessible. `/var/lib/phase-datahub-soak` and the proposed `/var/lib/phase-datahub-soak/m13-1947a1e/pgdata` did not exist. The preflight checked for symlinks as well as existing paths. |
| 7. Installed PostgreSQL 17 and version | **FAIL** | The guest had no installed PostgreSQL packages in the package inventory, no server binary in the checked system locations, and no `postgres`, `psql` or `pg_dump` on its default PATH. The local APT cache had no `postgresql-17` candidate. An installed server version was therefore unavailable. |
| 7. Upstream PostgreSQL 17 package | **PASS** | From the VPS, the official PGDG `noble-pgdg/main/binary-amd64` catalogue was retrieved and listed `postgresql-17` releases including `17.12-1.pgdg24.04+1`, the newest version in the returned entries. This is upstream availability. |
| 8. D-drive backup directory | **FAIL** | `D:\PhaseDataHub\.local` exists. The proposed root `D:\PhaseDataHub\.local\m13-soak` does not exist. |
| 8. Backup destination access controls | **NOT VERIFIED** | The per-run destination is absent. |
| 8. D-drive capacity | **PASS** | NTFS drive D had **179.0 GiB free** (192,201,285,632 bytes). It has enough current headroom for multiple 30 GiB VM-disk equivalents. Actual run, dump and restore sizes remain unmeasured. |
| 9. Existing IAP SSH | **PASS** | Successfully opened an IAP tunnel and ran read-only guest commands using an already registered OS Login key and the pinned VM host key. The key used for this check was valid until 27 November 2026 at approximately 23:31 IST. No key was added or extended. |
| 9. Outbound DNS and HTTPS | **PASS** | DNS resolution and valid TLS succeeded from the guest for the Phase RPC endpoint, GitHub, Node.js distribution, npm registry and PGDG. Phase answered HTTP `405` to HEAD. The other four endpoints answered HTTP `200`. |
| 9. Live Phase JSON-RPC method behavior | **NOT VERIFIED** | The preflight sent only an HTTPS HEAD to the Phase endpoint. No JSON-RPC request was sent. |
| Additional guest prerequisite | **FAIL** | `node` and `npm` were unavailable on the guest's default PATH. |
| Backup and soak verification | **NOT VERIFIED** | No backup or restore was run. Actual 24-hour resource growth, exact backup sizing, and future execution of the deletion schedule remain unverified. |

[Published Git commit](https://github.com/omkar150p/phase-datahub/commit/71a8afb351cb009d3b2afc1bcef677677f75df4e) · [Compute Engine instance](https://console.cloud.google.com/compute/instancesDetail/zones/asia-south1-a/instances/phase-datahub-vps?project=phase-datahub-261127) · [Compute Engine scheduling fields](https://docs.cloud.google.com/compute/docs/reference/rest/v1/instances) · [Official PostgreSQL package catalogue](https://apt.postgresql.org/pub/repos/apt/dists/noble-pgdg/)

## Review decision

**Hold before setup or soak.** PostgreSQL 17 is available upstream and absent on the guest. The proposed backup root is absent, and the guest runtime commands are unavailable on PATH. The next review should address these prerequisites and the isolated backup/restore plan.

The collector and soak were not launched. No database or migration was run, and no connection was made to the historical archive on port `55432`. This preflight changed no guest configuration, firewall, IAM, billing, lifecycle schedule or cloud permissions. The findings report is the only workspace change.
