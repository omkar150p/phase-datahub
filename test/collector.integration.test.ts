import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, beforeEach, test } from "node:test";
import type { Pool } from "pg";
import { buildApi } from "../src/api.js";
import { Collector, type CollectorOptions } from "../src/collector.js";
import { ArchiveDatabase, createPool, migrate } from "../src/database.js";
import { fixtureResult, mockPhase, mockServer, quiet, reply, wireView } from "./support.js";

const schema = "phase_test_" + randomUUID().replaceAll("-", "");
let admin: Pool | undefined;
let pool: Pool;
let db: ArchiveDatabase;
const options: CollectorOptions = {
  batchSize: 20,
  overlapViews: 4,
  pollIntervalMs: 25,
  catchupIntervalMs: 25,
  observationGapMs: 5_000,
  retentionProbeIntervalMs: 60_000,
  headIntervalMs: 20_000,
};

before(async () => {
  const url = process.env.TEST_DATABASE_URL;
  if (!url) throw new Error("Set TEST_DATABASE_URL to run the native PostgreSQL integration suite");
  admin = createPool(url);
  await admin.query("CREATE SCHEMA " + schema);
  pool = createPool(url, "-c search_path=" + schema);
  db = new ArchiveDatabase(pool);
  await migrate(pool);
});

beforeEach(async () => {
  await pool.query("TRUNCATE sources RESTART IDENTITY CASCADE");
});

after(async () => {
  if (pool) await pool.end();
  if (admin) {
    try {
      await admin.query("DROP SCHEMA IF EXISTS " + schema + " CASCADE");
    } finally {
      await admin.end();
    }
  }
});

async function boot(mock: Awaited<ReturnType<typeof mockServer>>, settings = {}) {
  const rpc = mock.rpc();
  const id = await db.registerSource(rpc.endpoint, await rpc.getIdentity());
  const collector = new Collector(id, rpc, db, { ...options, ...settings }, quiet);
  return { id, collector };
}

async function views() {
  return (await pool.query("SELECT * FROM consensus_views ORDER BY view_id")).rows;
}

async function activeGaps() {
  const query = "SELECT first_view_id, last_view_id, state FROM view_gaps " +
    "WHERE superseded_at IS NULL ORDER BY first_view_id";
  return (await pool.query(query)).rows.map((gap) => [gap.first_view_id, gap.last_view_id, gap.state]);
}

test("repeated batches keep one projection per view and preserve each raw response", async () => {
  const mock = await mockPhase();
  try {
    mock.setViews(wireView(100), wireView(101));
    const { collector, id } = await boot(mock);
    await collector.pollOnce();
    const first = await views();
    await collector.pollOnce();
    const repeated = await views();
    assert.deepEqual(repeated.map((row) => row.view_id), ["100", "101"]);
    assert.equal(repeated[0].first_response_id, first[0].first_response_id);
    assert.equal(repeated[0].current_response_id, first[0].current_response_id);
    assert.deepEqual(repeated[0].last_updated_at, first[0].last_updated_at);
    assert.equal((await db.checkpoint(id)).highViewId, "101");
    const results = await pool.query("SELECT response_body FROM rpc_responses WHERE purpose = 'view_page' ORDER BY id");
    assert.equal(results.rowCount, 2);
    assert.ok(Buffer.isBuffer(results.rows[0].response_body));
  } finally {
    await mock.close();
  }
});

test("tentative-to-full updates the same view while preserving original bytes and ignoring a regression", async () => {
  const mock = await mockPhase();
  try {
    const tentative = wireView(25, { is_tentative: true, signer_count: 3 });
    const full = wireView(25, { is_tentative: false, signer_count: 9 });
    mock.setViews(tentative);
    const { collector } = await boot(mock);
    await collector.pollOnce();
    const initial = (await views())[0];
    assert.equal(initial.certificate_status, "tentative");
    mock.setViews(full);
    await collector.pollOnce();
    mock.setViews(tentative);
    await collector.pollOnce();
    const stored = await views();
    assert.equal(stored.length, 1);
    const result = stored[0];
    assert.equal(result.certificate_status, "full");
    assert.equal(result.normalized_record.signerCount, "9");
    assert.equal(result.first_response_id, initial.first_response_id);
    assert.notEqual(result.current_response_id, initial.current_response_id);
    assert.deepEqual(result.first_observed_at, initial.first_observed_at);
    assert.deepEqual(result.ingested_at, initial.ingested_at);
    const evidence = await pool.query("SELECT id, response_body FROM rpc_responses WHERE purpose='view_page' ORDER BY id");
    assert.deepEqual(evidence.rows.map((row) => JSON.parse(row.response_body.toString()).result[0].is_tentative),
      [true, false, true]);
    const requestId = mock.requests.find((req) => req.method === "phase_getViewRecords")!.id;
    assert.deepEqual(evidence.rows[0].response_body, Buffer.from(JSON.stringify({
      jsonrpc: "2.0", id: requestId, result: [tentative],
    })));
    assert.equal(evidence.rows[1].id, result.current_response_id);
  } finally {
    await mock.close();
  }
});

test("a failed consensus insert never advances the checkpoint", async () => {
  const mock = await mockPhase();
  try {
    mock.setViews(wireView(100));
    const { collector, id } = await boot(mock);
    await collector.pollOnce();
    const beforeFailure = await db.checkpoint(id);
    await pool.query("ALTER TABLE consensus_views ADD CONSTRAINT reject_test_view CHECK (view_id < 110)");
    try {
      mock.setViews(wireView(100), wireView(110));
      await assert.rejects(collector.pollOnce(), /reject_test_view/);
      assert.deepEqual(await db.checkpoint(id), beforeFailure);
      assert.deepEqual((await views()).map(({ view_id }) => view_id), ["100"]);
      assert.deepEqual(await activeGaps(), []);
    } finally {
      await pool.query("ALTER TABLE consensus_views DROP CONSTRAINT reject_test_view");
    }
    await collector.pollOnce();
    assert.equal((await db.checkpoint(id)).highViewId, "110");
  } finally {
    await mock.close();
  }
});

test("a late checkpoint failure rolls back the raw batch, inserted view, and new gap", async () => {
  const mock = await mockPhase();
  try {
    mock.setViews(wireView(100));
    const { collector, id } = await boot(mock);
    await collector.pollOnce();
    const priorCheckpoint = await db.checkpoint(id);
    const priorResponses = (await pool.query("SELECT id FROM rpc_responses ORDER BY id")).rows;
    await pool.query("ALTER TABLE collector_checkpoints ADD CONSTRAINT reject_test_checkpoint CHECK (high_view_id < 104)");
    try {
      mock.setViews(wireView(100), wireView(104));
      await assert.rejects(collector.pollOnce(), /reject_test_checkpoint/);
      assert.deepEqual(await db.checkpoint(id), priorCheckpoint);
      assert.deepEqual((await views()).map(({ view_id }) => view_id), ["100"]);
      assert.deepEqual((await pool.query("SELECT id FROM rpc_responses ORDER BY id")).rows, priorResponses);
      assert.deepEqual(await activeGaps(), []);
    } finally {
      await pool.query("ALTER TABLE collector_checkpoints DROP CONSTRAINT reject_test_checkpoint");
    }
    await collector.pollOnce();
    assert.equal((await db.checkpoint(id)).highViewId, "104");
    assert.deepEqual(await activeGaps(), [["101", "103", "candidate_sequence_gap"]]);
  } finally {
    await mock.close();
  }
});

test("restart loads the durable cursor and catches up through overlapping pages without duplicates", async () => {
  const mock = await mockPhase();
  try {
    mock.setViews(wireView(200), wireView(201), wireView(202), wireView(203), wireView(204));
    const settings = { overlapViews: 1, batchSize: 3 };
    const first = await boot(mock, settings);
    await first.collector.pollOnce();
    assert.equal((await db.checkpoint(first.id)).highViewId, "202");
    const second = await boot(mock, settings);
    assert.equal(second.id, first.id);
    const requestsBefore = mock.requests.length;
    await second.collector.pollOnce();
    assert.deepEqual(mock.requests[requestsBefore]!.params, [202, 3]);
    assert.equal((await db.checkpoint(second.id)).highViewId, "204");
    assert.deepEqual((await views()).map((row) => row.view_id), ["200", "201", "202", "203", "204"]);
  } finally {
    await mock.close();
  }
});

test("view IDs drive candidate gaps, independent of block heights and view timestamps", async () => {
  const mock = await mockPhase();
  try {
    mock.setViews(
      wireView(100, { block_height: 10, timestamp_secs: 1 }),
      wireView(101, { block_height: 993, timestamp_secs: 80_000 }),
      wireView(105, { block_height: 993, timestamp_secs: 80_000 }),
    );
    const { collector } = await boot(mock);
    await collector.pollOnce();
    assert.deepEqual(await activeGaps(), [["102", "104", "candidate_sequence_gap"]]);
    mock.setViews(wireView(100), wireView(101), wireView(103), wireView(105));
    await collector.pollOnce();
    assert.deepEqual(await activeGaps(), [
      ["102", "102", "candidate_sequence_gap"], ["104", "104", "candidate_sequence_gap"],
    ]);
    assert.equal((await pool.query("SELECT id FROM view_gaps WHERE superseded_at IS NOT NULL")).rowCount, 1);
    assert.equal((await pool.query("SELECT id FROM collector_observation_gaps")).rowCount, 0);
  } finally {
    await mock.close();
  }
});

test("retention exhaustion records only the prefix below an evidenced floor as unrecoverable", async () => {
  const mock = await mockPhase();
  try {
    mock.setViews(wireView(100), wireView(101));
    const first = await boot(mock);
    await first.collector.pollOnce();
    await pool.query("UPDATE collector_checkpoints SET last_success_at = now() - interval '2 hours'");
    mock.setViews(wireView(109), wireView(111));
    const restarted = await boot(mock);
    await restarted.collector.pollOnce();

    assert.deepEqual(await activeGaps(), [
      ["102", "108", "unrecoverable_from_source"], ["110", "110", "candidate_sequence_gap"],
    ]);
    const evidence = await pool.query(
      "SELECT r.purpose, r.request_body FROM view_gaps g JOIN rpc_responses r ON r.id = g.evidence_response_id " +
      "WHERE g.state = 'unrecoverable_from_source'",
    );
    assert.equal(evidence.rows[0].purpose, "retention_probe");
    assert.deepEqual(JSON.parse(evidence.rows[0].request_body).params, [null, 10_000]);
    assert.equal((await pool.query("SELECT id FROM collector_observation_gaps")).rowCount, 1);
    assert.equal((await db.checkpoint(first.id)).highViewId, "111");
  } finally {
    await mock.close();
  }
});

test("a full page from a custom endpoint does not establish the retention floor", async () => {
  const mock = await mockPhase();
  try {
    mock.setViews(wireView(100), wireView(101));
    const { collector } = await boot(mock);
    await collector.pollOnce();

    const repeated = wireView(110);
    mock.setViews(...Array.from({ length: 10_000 }, () => repeated));
    await collector.pollOnce();

    assert.deepEqual(await activeGaps(), [["102", "109", "candidate_sequence_gap"]]);
    const checkpoint = await pool.query("SELECT retention_floor_view_id, last_retention_probe_at FROM collector_checkpoints");
    assert.equal(checkpoint.rows[0].retention_floor_view_id, null);
    assert.ok(checkpoint.rows[0].last_retention_probe_at instanceof Date);
  } finally {
    await mock.close();
  }
});

test("a retention-window probe restores a candidate that has moved outside the overlap", async () => {
  const mock = await mockPhase();
  try {
    mock.setViews(wireView(100), wireView(101), wireView(105));
    const { collector } = await boot(mock, { overlapViews: 1 });
    await collector.pollOnce();
    assert.deepEqual(await activeGaps(), [["102", "104", "candidate_sequence_gap"]]);

    mock.setViews(wireView(100), wireView(101), wireView(103), wireView(102), wireView(104), wireView(105), wireView(106));
    await collector.pollOnce();
    assert.deepEqual(await activeGaps(), []);
    assert.deepEqual((await views()).map((view) => view.view_id), ["100", "101", "102", "103", "104", "105", "106"]);
    const proof = await pool.query(
      "SELECT r.purpose FROM consensus_views v JOIN rpc_responses r ON r.id=v.first_response_id WHERE view_id=102",
    );
    assert.equal(proof.rows[0].purpose, "retention_probe");
  } finally {
    await mock.close();
  }
});

test("the collector bypasses overlap once when repeated wire observations fill a page without progress", async () => {
  const mock = await mockPhase();
  try {
    mock.setViews(wireView(100), wireView(101));
    const { collector } = await boot(mock, { overlapViews: 2, batchSize: 3 });
    await collector.pollOnce();
    mock.setViews(wireView(100), wireView(100), wireView(101), wireView(102));
    const stalled = await collector.pollOnce();
    assert.equal(stalled.highViewId, "101");
    assert.equal(stalled.catchup, true);
    const next = await collector.pollOnce();
    assert.deepEqual(mock.requests.at(-1)?.params, [102, 3]);
    assert.equal(next.highViewId, "102");
    assert.deepEqual((await views()).map((row) => row.view_id), ["100", "101", "102"]);
  } finally {
    await mock.close();
  }
});

test("an empty retention probe confirms no source floor and leaves gaps as candidates", async () => {
  const mock = await mockPhase();
  try {
    mock.setViews(wireView(100));
    const { collector } = await boot(mock);
    await collector.pollOnce();
    mock.setEmptyFloorProbe();
    mock.setViews(wireView(110));
    await collector.pollOnce();
    assert.deepEqual(await activeGaps(), [["101", "109", "candidate_sequence_gap"]]);
    assert.equal((await pool.query("SELECT retention_floor_view_id FROM collector_checkpoints")).rows[0].retention_floor_view_id, null);
  } finally {
    await mock.close();
  }
});

test("an empty page preserves the high cursor and records successful observation without inventing a view gap", async () => {
  const mock = await mockPhase();
  try {
    mock.setViews(wireView(30));
    const { collector, id } = await boot(mock, { overlapViews: 0 });
    await collector.pollOnce();
    const beforeEmpty = await db.checkpoint(id);
    mock.setViews();
    await collector.pollOnce();
    const afterEmpty = await db.checkpoint(id);
    assert.equal(afterEmpty.highViewId, "30");
    assert.notEqual(afterEmpty.revision, beforeEmpty.revision);
    assert.ok(afterEmpty.lastSuccessAt instanceof Date);
    assert.equal((await views()).length, 1);
    assert.deepEqual(await activeGaps(), []);
  } finally {
    await mock.close();
  }
});

test("PostgreSQL stores and reuses uint64 cursors without precision loss", async () => {
  const idText = "18446744073709551614";
  const mock = await mockServer(({ id, method, body }, res) => {
    if (method === "eth_chainId") {
      reply(res, id, fixtureResult("chain-id"));
    } else if (method === "eth_getBlockByNumber") {
      reply(res, id, fixtureResult("genesis-block"));
    } else {
      if (!body.includes('"params":[null,')) assert.match(body, /"params":\[18446744073709551614,20\]/);
      const raw = JSON.stringify({ jsonrpc: "2.0", id, result: [wireView(991, { block_height: 992 })] });
      res.end(raw.replace('"view":991', '"view":' + idText).replace('"block_height":992', '"block_height":9007199254740993'));
    }
  });
  try {
    const { collector, id } = await boot(mock, { overlapViews: 1 });
    await collector.pollOnce();
    await collector.pollOnce();
    const record = (await views())[0];
    assert.equal(record.view_id, idText);
    assert.equal(record.block_height, "9007199254740993");
    assert.equal(record.normalized_record.viewId, idText);
    assert.equal((await db.checkpoint(id)).highViewId, idText);
  } finally {
    await mock.close();
  }
});

test("latest and finalized block heads are distinct source observations", async () => {
  const mock = await mockPhase();
  try {
    const { collector, id } = await boot(mock);
    await collector.observeHeads();
    const heads = await pool.query("SELECT tag, height FROM block_head_observations WHERE source_id=$1 ORDER BY tag", [id]);
    assert.deepEqual(heads.rows, ["finalized", "latest"].map((tag) => ({
      tag, height: BigInt((fixtureResult(tag + "-block") as { number: string }).number).toString(),
    })));
    assert.equal((await db.checkpoint(id)).highViewId, null);
    assert.equal((await views()).length, 0);
  } finally {
    await mock.close();
  }
});

test("API returns at most 20 newest views, source, coverage, and separate finality", async () => {
  const mock = await mockPhase();
  const api = buildApi(pool, mock.endpoint, quiet);
  try {
    mock.setViews(...Array.from({ length: 22 }, (_, index) => wireView(100 + index)), wireView(124, { is_tentative: true }));
    const { collector } = await boot(mock);
    await collector.pollOnce();
    await collector.pollOnce();
    await collector.observeHeads();

    const response = await api.inject({ method: "GET", url: "/v1/consensus/views?limit=20" });
    assert.equal(response.statusCode, 200);
    const data = response.json();
    assert.equal(data.source.status, "source_observed");
    assert.equal(data.source.endpoint, mock.endpoint);
    assert.equal(data.views.length, 20);
    assert.equal(data.views[0].record.viewId, "124");
    assert.equal(data.views[0].record.certificateStatus, "tentative");
    assert.equal(data.views[0].rpcMethod, "phase_getViewRecords");
    assert.equal(data.views[19].record.viewId, "103");
    assert.equal(data.coverage.firstObservedViewId, "100");
    assert.equal(data.coverage.highObservedViewId, "124");
    assert.equal(data.coverage.knownViewGaps[0].state, "candidate_sequence_gap");
    assert.deepEqual(data.coverage.collectorObservationGaps, []);
    assert.notEqual(data.blockHeads.latest.hash, data.blockHeads.finalized.hash);
  } finally {
    await api.close();
    await mock.close();
  }
});

test("API handles default and empty results and rejects invalid limits", async () => {
  const api = buildApi(pool, "http://127.0.0.1:9999", quiet);
  try {
    const response = await api.inject({ method: "GET", url: "/v1/consensus/views" });
    assert.equal(response.statusCode, 200);
    const data = response.json();
    assert.equal(data.source.registered, false);
    assert.deepEqual(data.views, []);
    assert.deepEqual(data.blockHeads, { latest: null, finalized: null });
    for (const query of ["0", "101", "1.5", "1e1", "a", "", "1&limit=2"]) {
      const invalid = await api.inject({ method: "GET", url: "/v1/consensus/views?limit=" + query });
      assert.equal(invalid.statusCode, 400);
    }
  } finally {
    await api.close();
  }
});

test("overlapping collector instances serialize the checkpoint and preserve superseded evidence", async () => {
  const mock = await mockPhase();
  try {
    mock.setViews(wireView(100), wireView(101));
    mock.setLatency(50);
    const { id, collector } = await boot(mock);
    const result = await Promise.all([collector.pollOnce(), collector.pollOnce()]);
    assert.equal(result.filter((item) => item.committed).length, 1);
    assert.equal((await db.checkpoint(id)).revision, "1");
    assert.deepEqual((await views()).map((row) => row.view_id), ["100", "101"]);
    const evidence = await pool.query("SELECT purpose FROM rpc_responses WHERE method = 'phase_getViewRecords' ORDER BY id");
    assert.deepEqual(evidence.rows.map((row) => row.purpose), ["view_page", "superseded_poll"]);
  } finally {
    await mock.close();
  }
});
