import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, beforeEach, test } from "node:test";
import type { Pool } from "pg";
import { buildApi, historicalQueries } from "../src/api.js";
import { Collector } from "../src/collector.js";
import { ArchiveDatabase, createPool, migrate, transaction } from "../src/database.js";
import { indexViewResponse } from "../src/observation-index.js";
import { backfillObservations, readViewIntegrity } from "../src/observation-tools.js";
import {
  decodeArchivedViewOccurrences, MAX_UINT64, PHASE_CHAIN_ID, PHASE_GENESIS, VIEW_METHOD, type ConsensusView,
} from "../src/phase-rpc.js";
import { fixtureResult, mockPhase, quiet, wireView, type WireView } from "./support.js";

const schema = "historical_test_" + randomUUID().replaceAll("-", "");
const route = "/v1/consensus/views";
const endpoint = "http://archive.test/phase";
const otherEndpoint = "http://other.test/phase";
const receipt = "2026-11-26T12:34:56.789Z";
const identity = { chainId: PHASE_CHAIN_ID, genesisHash: PHASE_GENESIS, evidence: [] };
const requestBody = JSON.stringify({ jsonrpc: "2.0", id: 1, method: VIEW_METHOD, params: [null, 1] });
const template = decodeArchivedViewOccurrences(requestBody,
  Buffer.from(JSON.stringify({ jsonrpc: "2.0", id: 1, result: [wireView(1)] })))[0]!.record;
let admin: Pool | undefined;
let pool: Pool;
let db: ArchiveDatabase;
let api: ReturnType<typeof buildApi>;

before(async () => {
  const url = process.env.TEST_DATABASE_URL;
  if (!url) throw new Error("Set TEST_DATABASE_URL to an isolated PostgreSQL test database");
  admin = createPool(url);
  await admin.query("CREATE SCHEMA " + schema);
  pool = createPool(url, "-c search_path=" + schema);
  await migrate(pool);
  db = new ArchiveDatabase(pool);
  api = buildApi(pool, endpoint, quiet);
});

beforeEach(async () => {
  await pool.query("TRUNCATE sources RESTART IDENTITY CASCADE");
});

after(async () => {
  await api?.close();
  await pool?.end();
  if (admin) {
    try {
      await admin.query("DROP SCHEMA IF EXISTS " + schema + " CASCADE");
    } finally {
      await admin.end();
    }
  }
});

function record(viewId: string, fields: Partial<ConsensusView> = {}): ConsensusView {
  return { ...template, viewId, ...fields };
}

async function addResponse(source: number, body = "synthetic test response") {
  const { rows: [row] } = await pool.query<{ id: string }>(
    `INSERT INTO rpc_responses (source_id, method, purpose, request_body, response_body, observed_at)
     VALUES ($1, $2, 'view_page', $3, $4, $5) RETURNING id`,
    [source, VIEW_METHOD, requestBody, Buffer.from(body), receipt],
  );
  return row!.id;
}

async function index(source: number, response: string, records: ConsensusView[]) {
  await transaction(pool, (client) => indexViewResponse(client, source, response,
    records.map((entry, responseIndex) => ({ responseIndex, record: entry }))));
}

async function project(source: number, response: string, records: ConsensusView[]) {
  await pool.query(
    `INSERT INTO consensus_views (source_id, view_id, view_timestamp_secs, block_height, certificate_status,
       normalized_record, first_response_id, current_response_id, first_observed_at, last_observed_at)
     SELECT $1, (r->>'viewId')::numeric, (r->>'viewTimestampSecs')::numeric,
       (r->>'blockHeight')::numeric, r->>'certificateStatus', r, $2, $2, $4, $4
     FROM jsonb_array_elements($3::jsonb) AS r`,
    [source, response, JSON.stringify(records), receipt],
  );
  await pool.query(
    `UPDATE collector_checkpoints SET high_view_id =
       (SELECT max(view_id) FROM consensus_views WHERE source_id = $1), last_success_at = $2
     WHERE source_id = $1`, [source, receipt],
  );
}

async function seed(source: number, ids: string[]) {
  const response = await addResponse(source);
  const records = ids.map((id) => record(id));
  await index(source, response, records);
  await project(source, response, records);
  return response;
}

async function list(query = "", server = api) {
  const result = await server.inject(route + query);
  assert.equal(result.statusCode, 200, result.body);
  return result.json();
}

async function lookup(id: string, code: number, server = api) {
  const result = await server.inject(route + "/" + id);
  assert.equal(result.statusCode, code, result.body);
  return result.json();
}

function ids(body: { views: { record: { viewId: string } }[] }) {
  return body.views.map(({ record }) => record.viewId);
}

async function gap(source: number, response: string, first: number, last = first,
  state = "candidate_sequence_gap", superseded = false) {
  await pool.query(
    `INSERT INTO view_gaps (source_id, first_view_id, last_view_id, state, detected_at, evidence_response_id,
       superseded_at) VALUES ($1, $2, $3, $4, $5, $6, CASE WHEN $7 THEN $5::timestamptz ELSE NULL END)`,
    [source, first, last, state, receipt, response, superseded],
  );
}

test("list preserves the envelope and handles default, 1, 20, 50 and 100 sized pages", async () => {
  const source = await db.registerSource(endpoint, identity);
  await seed(source, Array.from({ length: 101 }, (_, offset) => String(offset + 1)));
  for (const limit of [undefined, 1, 20, 50, 100]) {
    const body = await list(limit === undefined ? "" : "?limit=" + limit);
    const size = limit ?? 20;
    assert.deepEqual(Object.keys(body).sort(), ["blockHeads", "coverage", "page", "source", "views"]);
    assert.equal(body.views.length, size);
    assert.deepEqual(ids(body), Array.from({ length: size }, (_, offset) => String(101 - offset)));
    assert.equal(new Date(body.page.asOf).toISOString(), body.page.asOf);
    assert.ok(Date.parse(body.page.asOf) >= Date.parse(body.views[0].ingestedAt));
    assert.deepEqual(body.page, { limit: size, beforeViewId: null, nextBeforeViewId: String(102 - size),
      hasMore: true, asOf: body.page.asOf });
    assert.deepEqual(Object.keys(body.views[0]).sort(), ["currentResponseId", "firstObservedAt", "firstResponseId",
      "ingestedAt", "lastObservedAt", "lastUpdatedAt", "record", "rpcMethod"]);
  }
  const exact = await list("?limit=50&beforeViewId=51");
  assert.equal(ids(exact).length, 50);
  assert.deepEqual(exact.page, { limit: 50, beforeViewId: "51", nextBeforeViewId: null, hasMore: false,
    asOf: exact.page.asOf });
  const terminal = await list("?limit=100&beforeViewId=2");
  assert.deepEqual(ids(terminal), ["1"]);
  assert.equal(terminal.page.nextBeforeViewId, null);
  assert.equal(terminal.page.hasMore, false);
  const empty = await list("?limit=1&beforeViewId=1");
  assert.deepEqual(ids(empty), []);
  assert.equal(empty.page.nextBeforeViewId, null);
  assert.equal(empty.page.hasMore, false);
});

test("numeric keysets preserve precision, accept zero and uint64 max, and allow a cursor inside a gap", async () => {
  const source = await db.registerSource(endpoint, identity);
  const max = MAX_UINT64.toString();
  const response = await seed(source, ["0", "9", "10", "100", "9007199254740991", "9007199254740992",
    "9007199254740993", max]);
  await gap(source, response, 11, 99);
  const all = await list();
  assert.deepEqual(ids(all), [max, "9007199254740993", "9007199254740992", "9007199254740991",
    "100", "10", "9", "0"]);
  const page = await list("?beforeViewId=" + max + "&limit=2");
  assert.deepEqual(ids(page), ["9007199254740993", "9007199254740992"]);
  assert.equal(page.page.nextBeforeViewId, "9007199254740992");
  assert.deepEqual(ids(await list("?beforeViewId=" + page.page.nextBeforeViewId + "&limit=2")),
    ["9007199254740991", "100"]);
  assert.deepEqual(ids(await list("?beforeViewId=50")), ["10", "9", "0"]);
  assert.deepEqual(ids(await list("?beforeViewId=0")), []);
  assert.equal((await lookup("0", 200)).view.record.viewId, "0");
  assert.equal((await lookup(max, 200)).view.record.viewId, max);
});

test("list and detail reject malformed unsigned IDs, overflows and repeated query parameters", async () => {
  const bad = ["", "00", "012", "-1", "+1", "1.0", "1e3", " 1", "1 ", "1\n", "1\t", "1/2", "NaN",
    "١", "18446744073709551616", "9".repeat(130)];
  for (const value of bad) {
    const encoded = encodeURIComponent(value);
    const response = await api.inject(route + "?beforeViewId=" + encoded);
    assert.equal(response.statusCode, 400, value);
    assert.deepEqual(response.json(), { error: "invalid_before_view_id" }, value);
    if (value !== "") assert.deepEqual(await lookup(encoded, 400), { error: "invalid_view_id" }, value);
  }
  assert.deepEqual(await lookup("%ZZ", 400), { error: "invalid_view_id" });
  for (const query of ["?beforeViewId", "?beforeViewId=1&beforeViewId=1", "?beforeViewId=1&beforeViewId=2"]) {
    const response = await api.inject(route + query);
    assert.equal(response.statusCode, 400);
    assert.deepEqual(response.json(), { error: "invalid_before_view_id" });
  }
  for (const query of ["?limit=1&limit=1", "?limit=101", "?limit=0", "?limit=01", "?limit=+1", "?limit=1.2"]) {
    const response = await api.inject(route + query);
    assert.equal(response.statusCode, 400);
    assert.deepEqual(response.json(), { error: "limit must be an integer from 1 to 100" });
  }
});

test("empty archives and all five missing states use source and active gap evidence precedence", async () => {
  const unregistered = await list("?limit=1&beforeViewId=8");
  assert.equal(unregistered.source.registered, false);
  assert.deepEqual(unregistered.views, []);
  assert.deepEqual(unregistered.page, { limit: 1, beforeViewId: "8", nextBeforeViewId: null, hasMore: false,
    asOf: unregistered.page.asOf });
  const missing = await lookup("8", 404);
  assert.deepEqual(missing, { error: "view_not_found", viewId: "8", lookupState: "source_unregistered",
    source: unregistered.source, coverage: unregistered.coverage });

  await pool.query("INSERT INTO sources (endpoint, chain_id, genesis_hash) VALUES ($1, $2, $3)",
    [endpoint, PHASE_CHAIN_ID, PHASE_GENESIS]);
  assert.equal((await lookup("8", 404)).lookupState, "unobserved");
  const source = await db.registerSource(endpoint, identity);
  const registered = await list();
  assert.equal(registered.source.registered, true);
  assert.equal(registered.coverage.highObservedViewId, null);
  assert.deepEqual(ids(registered), []);

  const response = await seed(source, ["100", "200"]);
  await gap(source, response, 80, 90, "unrecoverable_from_source");
  await gap(source, response, 103, 104);
  await gap(source, response, 110, 110, "unrecoverable_from_source", true);
  await gap(source, response, 100);
  for (let i = 0; i < 21; i++) await gap(source, response, 120 + i);
  const unavailable = await lookup("85", 404);
  assert.equal(unavailable.lookupState, "unrecoverable_from_source");
  assert.deepEqual(unavailable.gap, { state: "unrecoverable_from_source", firstViewId: "80",
    lastViewId: "90", detectedAt: receipt, evidenceResponseId: response });
  const candidate = await lookup("104", 404);
  assert.equal(candidate.lookupState, "candidate_sequence_gap");
  assert.equal(candidate.coverage.knownViewGaps.length, 20);
  assert.equal(candidate.coverage.hasMoreViewGaps, true);
  assert.ok(candidate.coverage.knownViewGaps.every((item: { firstViewId: string }) => item.firstViewId !== "103"));
  assert.equal(candidate.gap.firstViewId, "103");
  for (const id of ["99", "201"]) assert.equal((await lookup(id, 404)).lookupState, "outside_observed_range");
  for (const id of ["110", "199"]) {
    const miss = await lookup(id, 404);
    assert.equal(miss.lookupState, "unobserved");
    assert.equal(miss.gap, undefined);
  }
  await lookup("100", 200);
});

test("list, observations, coverage and direct gaps are isolated by source identity", async (t) => {
  const source = await db.registerSource(endpoint, identity);
  const peer = await db.registerSource(otherEndpoint, identity);
  const fork = await db.registerSource(endpoint, { ...identity, chainId: "0" });
  const first = await seed(source, ["10", "20"]);
  const second = await seed(peer, ["10", "22"]);
  await seed(fork, ["99"]);
  await gap(peer, second, 15);
  await addResponse(peer);
  await index(peer, await addResponse(peer),
    [record("10", { signers: ["3030"], signerCount: "1" })]);

  const otherApi = buildApi(pool, otherEndpoint, quiet);
  t.after(() => otherApi.close());
  assert.deepEqual(ids(await list("?beforeViewId=90")), ["20", "10"]);
  assert.deepEqual(ids(await list("?beforeViewId=90", otherApi)), ["22", "10"]);
  assert.equal((await lookup("15", 404)).lookupState, "unobserved");
  assert.equal((await lookup("15", 404, otherApi)).gap.evidenceResponseId, second);
  const local = await lookup("10", 200);
  const remote = await lookup("10", 200, otherApi);
  assert.deepEqual(local.source, { endpoint, chainId: PHASE_CHAIN_ID, genesisHash: PHASE_GENESIS,
    registered: true, status: "source_observed" });
  assert.equal(local.view.currentResponseId, first);
  assert.equal(remote.source.endpoint, otherEndpoint);
  assert.equal(remote.view.currentResponseId, second);
  assert.equal(local.integrity.status, "no_discrepancy_observed");
  assert.equal(local.integrity.coverage.pending, false);
  assert.equal(remote.integrity.coverage.pending, true);
  assert.equal(remote.integrity.status, "unresolved");
});

test("replaying saved mainnet responses returns all three signer discrepancies and current provenance", async (t) => {
  const captures = [
    { file: "live-order-11", samples: [["8294199", 20, 22], ["8294232", 53, 55]] as const },
    { file: "live-order-12", samples: [["8294794", 14, 16]] as const },
  ];
  for (const capture of captures) {
    const mock = await mockPhase();
    const fixtureApi = buildApi(pool, mock.endpoint, quiet);
    t.after(() => Promise.all([fixtureApi.close(), mock.close()]).then(() => undefined));
    mock.setViews(...fixtureResult(capture.file) as WireView[]);
    const rpc = mock.rpc();
    const source = await db.registerSource(rpc.endpoint, await rpc.getIdentity());
    const collector = new Collector(source, rpc, db, {
      batchSize: 100, overlapViews: 4, pollIntervalMs: 25, catchupIntervalMs: 25, observationGapMs: 5_000,
      retentionProbeIntervalMs: 60_000, headIntervalMs: 20_000,
    }, quiet);
    await collector.pollOnce();
    await collector.observeHeads();
    for (const [id, first, second] of capture.samples) {
      const body = await lookup(id, 200, fixtureApi);
      const { view, integrity, blockHeads } = body;
      assert.equal(view.record.viewId, id);
      assert.equal(view.rpcMethod, VIEW_METHOD);
      assert.equal(view.firstResponseId, view.currentResponseId);
      assert.equal(view.currentResponseIndex, second);
      assert.deepEqual(body.source, { endpoint: mock.endpoint, chainId: PHASE_CHAIN_ID, genesisHash: PHASE_GENESIS,
        status: "source_observed", registered: true });
      const response = await pool.query("SELECT observed_at, ingested_at FROM rpc_responses WHERE id=$1",
        [view.currentResponseId]);
      assert.equal(view.firstObservedAt, response.rows[0].observed_at.toISOString());
      assert.equal(view.lastObservedAt, view.firstObservedAt);
      assert.ok(Date.parse(view.ingestedAt) >= response.rows[0].ingested_at.valueOf());
      assert.notEqual(view.record.viewTimestampSecs, Math.floor(Date.parse(view.firstObservedAt) / 1000).toString());
      assert.notEqual(blockHeads.latest.responseId, blockHeads.finalized.responseId);
      assert.notEqual(blockHeads.latest.height, blockHeads.finalized.height);
      assert.equal(integrity.status, "unresolved");
      assert.ok(integrity.findingTypes.includes("signer_membership_variation"));
      assert.equal(integrity.scannedOccurrences, 2);
      assert.deepEqual(integrity.coverage, { pending: false, unsupported: false, truncated: false,
        scope: "archived_responses" });
      assert.deepEqual(integrity.evidence, [first, second].map((responseIndex) => ({
        responseId: view.currentResponseId, responseIndex,
      })));
      if (id === "8294199") {
        const page = await list("?limit=2&beforeViewId=8294200", fixtureApi);
        t.diagnostic("sample list " + JSON.stringify({ views: ids(page), page: page.page }));
        t.diagnostic("sample detail " + JSON.stringify({ source: body.source, view, blockHeads, integrity }));
      }
    }
  }
});


test("pending, unsupported and empty legacy evidence are unknown and expose nullable legacy offsets", async () => {
  const source = await db.registerSource(endpoint, identity);
  const original = await seed(source, ["18"]);
  const pending = await addResponse(source, "unsupported historical body");
  const pendingRead = await lookup("18", 200);
  assert.equal(pendingRead.view.currentResponseIndex, null);
  assert.equal(pendingRead.view.firstResponseId, original);
  assert.equal(pendingRead.view.currentResponseId, original);
  for (const key of ["firstObservedAt", "lastObservedAt", "lastUpdatedAt", "ingestedAt"]) {
    const value = pendingRead.view[key];
    assert.equal(new Date(value).toISOString(), value);
  }
  assert.deepEqual(pendingRead.integrity, { status: "unknown", findingTypes: [], scannedOccurrences: 1,
    coverage: { pending: true, unsupported: false, truncated: false, scope: "archived_responses" }, evidence: [] });
  assert.deepEqual(await backfillObservations(pool, 1), { indexed: 0, unsupported: 1, occurrences: 0 });
  const unsupported = await lookup("18", 200);
  assert.deepEqual(unsupported.integrity.coverage,
    { pending: false, unsupported: true, truncated: false, scope: "archived_responses" });
  assert.equal(unsupported.integrity.status, "unknown");
  await project(source, pending, [record("19")]);
  const absent = await lookup("19", 200);
  assert.equal(absent.integrity.scannedOccurrences, 0);
  assert.equal(absent.integrity.status, "unknown");
  assert.equal(absent.view.currentResponseIndex, null);
});

test("identical occurrences and tentative-to-full transitions retain M1.1 interpretation", async () => {
  const source = await db.registerSource(endpoint, identity);
  const response = await addResponse(source);
  const full = record("20", { certificateStatus: "full", isTentative: false, success: true });
  const tentative = { ...full, certificateStatus: "tentative", isTentative: true } as const;
  const identical = record("21");
  await index(source, response, [tentative, full, identical, identical]);
  await project(source, response, [full, identical]);
  const same = (await lookup("21", 200)).integrity;
  assert.equal(same.status, "no_discrepancy_observed");
  assert.equal(same.scannedOccurrences, 2);
  assert.deepEqual(same.findingTypes, []);
  assert.deepEqual(same.evidence, []);
  const transitioned = (await lookup("20", 200)).integrity;
  assert.equal(transitioned.status, "reported_transition");
  assert.deepEqual(transitioned.findingTypes, ["tentative_to_full_observed"]);
  assert.deepEqual(transitioned.evidence, [0, 1].map((responseIndex) => ({ responseId: response, responseIndex })));
});

test("1,000 occurrence cap and five unique evidence references preserve conservative status", async (t) => {
  const source = await db.registerSource(endpoint, identity);
  const response = await addResponse(source);
  const base = record("27", { certificateStatus: "full", isTentative: false, success: true,
    blockHash: "0x" + "11".repeat(32), signers: ["1", "2"], signerCount: "2" });
  const differentSigners = { ...base, signers: ["1", "3"] };
  const conflicts = [
    base, differentSigners, { ...base, signerCount: "3" }, { ...base, signers: ["1", "1"] },
    { ...base, epoch: "7" }, { ...base, blockHash: "0x" + "22".repeat(32) },
  ];
  const other = { ...base, viewId: "28" };
  await index(source, response, [
    ...conflicts, ...Array<ConsensusView>(1_001 - conflicts.length).fill(base),
    ...Array<ConsensusView>(1_000).fill(other), { ...differentSigners, viewId: "28" },
  ]);
  await project(source, response, [base, other]);
  const start = performance.now();
  const result = await api.inject(route + "/27");
  const duration = performance.now() - start;
  assert.equal(result.statusCode, 200, result.body);
  const { integrity } = result.json();
  assert.equal(integrity.status, "unresolved");
  assert.equal(integrity.scannedOccurrences, 1_000);
  assert.deepEqual(integrity.coverage, { pending: false, unsupported: false, truncated: true,
    scope: "archived_responses" });
  for (const finding of ["signer_membership_variation", "same_status_hash_variation", "signer_count_mismatch",
    "duplicate_signer_indices", "view_context_variation"]) {
    assert.ok(integrity.findingTypes.includes(finding), finding);
  }
  assert.equal(integrity.evidence.length, 5);
  assert.ok(integrity.evidence.every((ref: { responseId: string }) => ref.responseId === response));
  assert.equal(new Set(integrity.evidence.map((ref: { responseIndex: number }) => ref.responseIndex)).size, 5);
  const truncated = (await lookup("28", 200)).integrity;
  assert.equal(truncated.status, "unknown");
  assert.equal(truncated.scannedOccurrences, 1_000);
  assert.equal(truncated.coverage.truncated, true);
  assert.deepEqual(truncated.evidence, []);
  await addResponse(source, "unsupported");
  await backfillObservations(pool, 1);
  const partialConflict = (await lookup("27", 200)).integrity;
  assert.equal(partialConflict.coverage.unsupported, true);
  assert.equal(partialConflict.status, "unresolved");
  assert.ok(duration < 2_000, String(duration));
  assert.ok(Buffer.byteLength(result.body) < 32 * 1024);
  t.diagnostic("1,000 occurrence detail " + JSON.stringify({ ms: duration, bytes: Buffer.byteLength(result.body) }));
});

test("late repairs above and below an exclusive cursor behave predictably across requests", async () => {
  const source = await db.registerSource(endpoint, identity);
  const response = await seed(source, ["10", "20", "30"]);
  await gap(source, response, 11, 19);
  await gap(source, response, 21, 29);
  const first = await list("?limit=2");
  assert.deepEqual(ids(first), ["30", "20"]);
  assert.equal(first.page.nextBeforeViewId, "20");
  await seed(source, ["15", "25"]);
  await pool.query("UPDATE view_gaps SET superseded_at = clock_timestamp() WHERE source_id = $1", [source]);
  const next = await list("?limit=2&beforeViewId=" + first.page.nextBeforeViewId);
  assert.deepEqual(ids(next), ["15", "10"]);
  assert.equal(next.page.hasMore, false);
  const refreshed = await list("?limit=2");
  assert.deepEqual(ids(refreshed), ["30", "25"]);
  assert.ok(Date.parse(refreshed.page.asOf) >= Date.parse(first.page.asOf));
});

function interleave(match: (sql: string) => boolean, write: () => Promise<void>) {
  let wrote = false;
  return new Proxy(pool, {
    get(target, key, receiver) {
      if (key !== "connect") return Reflect.get(target, key, receiver);
      return async () => {
        const client = await target.connect();
        return new Proxy(client, {
          get(connection, property) {
            if (property === "query") {
              return async (sql: string, params?: unknown[]) => {
                const result = await connection.query(sql, params);
                if (!wrote && match(sql)) {
                  wrote = true;
                  await write();
                }
                return result;
              };
            }
            const value = Reflect.get(connection, property);
            return typeof value === "function" ? value.bind(connection) : value;
          },
        });
      };
    },
  });
}

test("list metadata and rows observe the same snapshot during a concurrent commit", async (t) => {
  const source = await db.registerSource(endpoint, identity);
  const first = await seed(source, ["20"]);
  const concurrent = buildApi(interleave((sql) => sql.includes("FROM sources s LEFT JOIN"), async () => {
    await seed(source, ["10", "30"]);
    await gap(source, first, 21, 29);
  }), endpoint, quiet);
  t.after(() => concurrent.close());
  const original = await list("", concurrent);
  assert.deepEqual(ids(original), ["20"]);
  assert.equal(original.coverage.firstObservedViewId, "20");
  assert.equal(original.coverage.highObservedViewId, "20");
  assert.deepEqual(original.coverage.knownViewGaps, []);
  const updated = await list();
  assert.deepEqual(ids(updated), ["30", "20", "10"]);
  assert.equal(updated.coverage.firstObservedViewId, "10");
  assert.equal(updated.coverage.highObservedViewId, "30");
  assert.equal(updated.coverage.knownViewGaps.length, 1);
});

test("view, coverage and integrity share a snapshot across concurrent projection and evidence changes", async (t) => {
  const source = await db.registerSource(endpoint, identity);
  const first = await seed(source, ["33"]);
  const changed = record("33", { signers: ["707"], signerCount: "1" });
  let current: string | undefined;
  const concurrent = buildApi(interleave((sql) => sql === historicalQueries.detail, async () => {
    current = await addResponse(source);
    await transaction(pool, async (client) => {
      await indexViewResponse(client, source, current!, [{ responseIndex: 0, record: changed }]);
      await client.query(
        `UPDATE consensus_views SET current_response_id = $2, current_response_index = 0, normalized_record = $3
         WHERE source_id = $1 AND view_id = 33`, [source, current, changed],
      );
      await client.query("UPDATE collector_checkpoints SET high_view_id = 40 WHERE source_id = $1", [source]);
    });
  }), endpoint, quiet);
  t.after(() => concurrent.close());
  const original = await lookup("33", 200, concurrent);
  assert.equal(original.view.currentResponseId, first);
  assert.equal(original.view.currentResponseIndex, null);
  assert.equal(original.coverage.highObservedViewId, "33");
  assert.equal(original.integrity.status, "no_discrepancy_observed");
  assert.equal(original.integrity.scannedOccurrences, 1);
  const updated = await lookup("33", 200);
  assert.equal(updated.view.firstResponseId, first);
  assert.equal(updated.view.currentResponseId, current);
  assert.equal(updated.view.currentResponseIndex, 0);
  assert.deepEqual(updated.view.record.signers, changed.signers);
  assert.equal(updated.coverage.highObservedViewId, "40");
  assert.equal(updated.integrity.status, "unresolved");
  assert.deepEqual(updated.integrity.evidence, [
    { responseId: first, responseIndex: 0 }, { responseId: current, responseIndex: 0 },
  ]);
});


test("missing-view classification and coverage share a snapshot with direct gap evidence", async (t) => {
  const source = await db.registerSource(endpoint, identity);
  const response = await seed(source, ["10", "20"]);
  const concurrent = buildApi(interleave((sql) => sql === historicalQueries.detail, async () => {
    await gap(source, response, 14, 16);
  }), endpoint, quiet);
  t.after(() => concurrent.close());
  const original = await lookup("15", 404, concurrent);
  assert.equal(original.lookupState, "unobserved");
  assert.equal(original.gap, undefined);
  assert.deepEqual(original.coverage.knownViewGaps, []);
  const updated = await lookup("15", 404);
  assert.equal(updated.lookupState, "candidate_sequence_gap");
  assert.equal(updated.gap.evidenceResponseId, response);
  assert.deepEqual(updated.coverage.knownViewGaps, [updated.gap]);
  t.diagnostic("sample missing detail " + JSON.stringify(updated));
});

test("both routes retain the generic 500 contract on unexpected database failure", async (t) => {
  const unavailable = new Proxy(pool, {
    get(target, key, receiver) {
      if (key === "connect") return async () => { throw new Error("test connection failure"); };
      return Reflect.get(target, key, receiver);
    },
  });
  const failing = buildApi(unavailable, endpoint, quiet);
  t.after(() => failing.close());
  for (const path of [route, route + "/10"]) {
    const response = await failing.inject(path);
    assert.equal(response.statusCode, 500);
    assert.deepEqual(response.json(), { error: "Could not read Phase DataHub" });
  }
});

interface PlanNode {
  "Node Type": string;
  "Index Name"?: string;
  "Index Cond"?: string;
  "Scan Direction"?: string;
  Plans?: PlanNode[];
}

function flattenPlan(node: PlanNode): PlanNode[] {
  return [node, ...node.Plans?.flatMap(flattenPlan) ?? []];
}

async function explain(sql: string, values: unknown[]) {
  const { rows } = await pool.query("EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) " + sql, values);
  const plan = rows[0]["QUERY PLAN"][0];
  const nodes = flattenPlan(plan.Plan);
  return { executionMs: plan["Execution Time"], nodes: nodes.map((node) => ({
    type: node["Node Type"], index: node["Index Name"], direction: node["Scan Direction"],
    condition: node["Index Cond"],
  })) };
}

test("large isolated archive uses keyset, detail and active-gap indexes with bounded responses", async (t) => {
  const source = await db.registerSource(endpoint, identity);
  const base = 9_007_199_254_740_990n;
  await transaction(pool, async (client) => {
    await client.query(
      `CREATE TEMP TABLE benchmark_response ON COMMIT DROP AS
       WITH saved AS (
         INSERT INTO rpc_responses (source_id, method, purpose, request_body, response_body, observed_at)
         SELECT $1, $2, 'view_page', n::text, convert_to('synthetic benchmark', 'UTF8'), $3
         FROM generate_series(0, 499) AS n RETURNING id, request_body
       )
       SELECT id, request_body::int AS batch FROM saved`, [source, VIEW_METHOD, receipt],
    );
    await client.query(
      `INSERT INTO observation_index_results (source_id, response_id, normalizer_version, outcome, occurrence_count)
       SELECT $1, id, 1, 'indexed', 200 FROM benchmark_response`, [source],
    );
    await client.query(
      `WITH sample AS (
         SELECT $2::numeric + n AS view_id, (row_number() OVER (ORDER BY n) - 1)::int AS seq
         FROM generate_series(1, 110000) AS n WHERE n % 11 <> 0
       )
       INSERT INTO consensus_view_observations (source_id, response_id, response_index, view_id,
         view_timestamp_secs, certificate_status, epoch, committee_round, block_hash, normalized_record, normalizer_version)
       SELECT $1, r.id, seq % 200, s.view_id, ($3::jsonb->>'viewTimestampSecs')::numeric,
         $3::jsonb->>'certificateStatus', ($3::jsonb->>'epoch')::numeric, ($3::jsonb->>'committeeRound')::numeric,
         $3::jsonb->>'blockHash', jsonb_set($3::jsonb, '{viewId}', to_jsonb(s.view_id::text)), 1
       FROM sample s JOIN benchmark_response r ON r.batch = seq / 200`, [source, base.toString(), template],
    );
    await client.query(
      `INSERT INTO consensus_views (source_id, view_id, view_timestamp_secs, block_height, certificate_status,
         normalized_record, first_response_id, current_response_id, current_response_index,
         first_observed_at, last_observed_at)
       SELECT source_id, view_id, view_timestamp_secs, (normalized_record->>'blockHeight')::numeric,
         certificate_status, normalized_record, response_id, response_id, response_index, $2, $2
       FROM consensus_view_observations WHERE source_id = $1`, [source, receipt],
    );
    await client.query(
      `INSERT INTO view_gaps (source_id, first_view_id, last_view_id, state, detected_at, evidence_response_id)
       SELECT $1, $2::numeric + n * 11, $2::numeric + n * 11, 'candidate_sequence_gap', $3, r.id
       FROM generate_series(1, 10000) AS n JOIN benchmark_response r ON r.batch = (n - 1) / 20`,
      [source, base.toString(), receipt],
    );
    await client.query(
      "UPDATE collector_checkpoints SET high_view_id = $2, last_success_at = $3 WHERE source_id = $1",
      [source, (base + 109_999n).toString(), receipt],
    );
  });
  for (const relation of ["consensus_views", "consensus_view_observations", "rpc_responses",
    "observation_index_results", "view_gaps"]) {
    await pool.query("ANALYZE " + relation);
  }

  const cursor = (base + 55_000n).toString();
  const detail = (base + 54_999n).toString();
  const plans = {
    keyset: await explain(historicalQueries.before, [source, cursor, 51]),
    detail: await explain(historicalQueries.detail, [source, detail]),
    gap: await explain(historicalQueries.gap, [source, cursor]),
  };
  assert.ok(plans.keyset.nodes.some((node) => node.index === "consensus_views_pkey" &&
    node.direction === "Backward" && node.condition?.includes("view_id <")));
  assert.ok(plans.detail.nodes.some((node) => node.index === "consensus_views_pkey" &&
    node.condition?.includes("view_id =")));
  assert.ok(plans.gap.nodes.some((node) => node.index === "active_view_gaps_by_source" &&
    node.condition?.includes("first_view_id <=") && node.condition.includes("last_view_id >=")));
  t.diagnostic("query plans " + JSON.stringify(plans));

  for (const [name, path, status, maxBytes] of [
    ["page50", "?limit=50&beforeViewId=" + cursor, 200, 512 * 1024],
    ["page100", "?limit=100&beforeViewId=" + cursor, 200, 512 * 1024],
    ["detail", "/" + detail, 200, 32 * 1024],
    ["gap", "/" + cursor, 404, 32 * 1024],
  ] as const) {
    await api.inject(route + path);
    const timings = [];
    let bytes = 0;
    for (let i = 0; i < 5; i++) {
      const start = performance.now();
      const response = await api.inject(route + path);
      timings.push(performance.now() - start);
      assert.equal(response.statusCode, status, response.body);
      const body = response.json();
      if (name === "detail") assert.equal(body.integrity.scannedOccurrences, 1);
      if (name === "gap") assert.equal(body.gap.firstViewId, cursor);
      if (name === "page50" || name === "page100") {
        assert.equal(body.views.length, name === "page50" ? 50 : 100);
        assert.equal(ids(body)[0], detail);
        assert.equal(body.page.hasMore, true);
      }
      bytes = Buffer.byteLength(response.body);
      assert.ok(bytes < maxBytes, String(bytes));
    }
    const maxMs = Math.max(...timings);
    assert.ok(maxMs < 2_000, String(maxMs));
    timings.sort((a, b) => a - b);
    t.diagnostic(name + " " + JSON.stringify({ bytes, medianMs: timings[2], maxMs }));
  }

  const integrityTimings: number[] = [];
  for (let i = 0; i < 5; i++) {
    const result = await transaction(pool, async (client) => {
      const start = performance.now();
      const integrity = await readViewIntegrity(client, source, detail);
      integrityTimings.push(performance.now() - start);
      return integrity;
    }, "read");
    assert.equal(result.scannedOccurrences, 1);
    assert.equal(result.status, "no_discrepancy_observed");
  }
  integrityTimings.sort((a, b) => a - b);
  t.diagnostic("integrity SQL and comparison " + JSON.stringify({
    medianMs: integrityTimings[2], maxMs: integrityTimings[4],
  }));
});
