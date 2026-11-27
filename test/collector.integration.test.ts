import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { after, before, beforeEach, test } from "node:test";
import type { Pool } from "pg";
import { buildApi } from "../src/api.js";
import { Collector, type CollectorOptions } from "../src/collector.js";
import { ArchiveDatabase, createPool, migrate } from "../src/database.js";
import { backfillObservations, inspectViewObservations } from "../src/observation-tools.js";
import { fixture, fixtureResult, mockPhase, mockServer, quiet, reply, wireView, type WireView } from "./support.js";

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

async function inUpgradeSchema(work: (upgrade: Pool) => Promise<void>) {
  const name = "phase_upgrade_" + randomUUID().replaceAll("-", "");
  await admin!.query("CREATE SCHEMA " + name);
  const upgrade = createPool(process.env.TEST_DATABASE_URL!, "-c search_path=" + name);
  try {
    await work(upgrade);
  } finally {
    await upgrade.end();
    await admin!.query("DROP SCHEMA " + name + " CASCADE");
  }
}

async function installLegacy(pool: Pool) {
  await pool.query(await readFile(new URL("../../db/001_init.sql", import.meta.url), "utf8"));
}

test("versioned migrations adopt a populated original schema and serialize concurrent upgrades", async () => {
  await inUpgradeSchema(async (upgrade) => {
    await installLegacy(upgrade);
    const legacy = new ArchiveDatabase(upgrade);
    const mock = await mockPhase();
    try {
      const rpc = mock.rpc();
      const source = await legacy.registerSource(rpc.endpoint, await rpc.getIdentity());
      const raw = Buffer.from(fixture("live-order-11"));
      const request = JSON.stringify({ id: 11, jsonrpc: "2.0", method: "phase_getViewRecords", params: [null, 60] });
      const inserted = await upgrade.query(
        "INSERT INTO rpc_responses(source_id, method, purpose, request_body, response_body, observed_at) " +
        "VALUES($1, 'phase_getViewRecords', 'view_page', $2, $3, now()) RETURNING id", [source, request, raw],
      );
      const response = inserted.rows[0].id;
      await upgrade.query("UPDATE collector_checkpoints SET high_view_id=8294237,revision=4 WHERE source_id=$1", [source]);
      await upgrade.query(
        "INSERT INTO consensus_views(source_id,view_id,view_timestamp_secs,certificate_status,normalized_record," +
        "first_response_id,current_response_id,first_observed_at,last_observed_at) " +
        "VALUES($1,8294199,1795712686,'full','{}',$2,$2,now(),now())", [source, response],
      );
      const checkpoint = await legacy.checkpoint(source);
      await Promise.all([migrate(upgrade), migrate(upgrade)]);
      await migrate(upgrade);

      const { rows } = await upgrade.query("SELECT version,name FROM schema_migrations ORDER BY version");
      assert.deepEqual(rows, [
        { version: 1, name: "001_init.sql" }, { version: 2, name: "002_observation_integrity.sql" },
      ]);
      assert.deepEqual(await legacy.checkpoint(source), checkpoint);
      assert.deepEqual((await upgrade.query("SELECT response_body FROM rpc_responses WHERE id=$1", [response])).rows[0].response_body, raw);
      assert.deepEqual((await upgrade.query("SELECT normalized_record, current_response_index FROM consensus_views")).rows[0],
        { normalized_record: {}, current_response_index: null });
      assert.deepEqual(await backfillObservations(upgrade, 1), { indexed: 1, unsupported: 0, occurrences: 60 });
      assert.deepEqual(await backfillObservations(upgrade, 1), { indexed: 0, unsupported: 0, occurrences: 0 });
      assert.deepEqual(await legacy.checkpoint(source), checkpoint);
    } finally {
      await mock.close();
    }
  });
});

test("unexpected legacy indexes and changed migration checksums are rejected", async () => {
  await inUpgradeSchema(async (upgrade) => {
    await installLegacy(upgrade);
    await upgrade.query("DROP INDEX active_view_gaps_by_source");
    await assert.rejects(migrate(upgrade), /Cannot adopt baseline.*view_gaps/);
    const { rows } = await upgrade.query("SELECT to_regclass('schema_migrations') AS ledger");
    assert.equal(rows[0].ledger, null);
  });
  await inUpgradeSchema(async (upgrade) => {
    await migrate(upgrade);
    await upgrade.query("UPDATE schema_migrations SET sha256=repeat('0',64) WHERE version=1");
    await assert.rejects(migrate(upgrade), /does not match the repository at version 1/);
  });
});

test("a failed migration rolls back the baseline DDL and version ledger", async () => {
  await inUpgradeSchema(async (upgrade) => {
    await upgrade.query("CREATE TABLE consensus_view_observations (placeholder integer)");
    await assert.rejects(migrate(upgrade), /consensus_view_observations.*already exists/);
    const { rows } = await upgrade.query("SELECT to_regclass('schema_migrations') AS ledger, to_regclass('sources') AS sources");
    assert.deepEqual(rows[0], { ledger: null, sources: null });
  });
});

test("real repeated responses retain all wire offsets with one compatible projection per view", async () => {
  const fixtures = [
    { file: "live-order-11", projected: 58, view: "8294199", offsets: [20, 22], winner: 22 },
    { file: "live-order-12", projected: 56, view: "8294794", offsets: [14, 16], winner: 16 },
  ];
  for (const sample of fixtures) {
    const mock = await mockPhase();
    try {
      mock.setViews(...fixtureResult(sample.file) as WireView[]);
      const { id, collector } = await boot(mock, { batchSize: 100 });
      const result = await collector.pollOnce();
      assert.equal(result.records, sample.projected);
      const total = await pool.query("SELECT count(*)::int AS total FROM consensus_view_observations WHERE source_id=$1", [id]);
      assert.equal(total.rows[0].total, 60);
      const observation = await inspectViewObservations(pool, id, sample.view);
      assert.equal(observation.status, "unresolved");
      const finding = observation.findings.find((item) => item.kind === "signer_membership_variation");
      assert.deepEqual(finding?.evidence.map((row) => row.responseIndex), sample.offsets);
      const projection = await pool.query("SELECT current_response_index FROM consensus_views WHERE source_id=$1 AND view_id=$2",
        [id, sample.view]);
      assert.equal(projection.rows[0].current_response_index, sample.winner);
    } finally {
      await mock.close();
    }
  }
});

test("an occurrence write failure rolls back raw evidence, projection and checkpoint", async () => {
  const mock = await mockPhase();
  try {
    mock.setViews(wireView(100));
    const { collector, id } = await boot(mock);
    const checkpoint = await db.checkpoint(id);
    await pool.query("ALTER TABLE consensus_view_observations ADD CONSTRAINT reject_occurrence CHECK (view_id <> 100)");
    try {
      await assert.rejects(collector.pollOnce(), /reject_occurrence/);
      assert.deepEqual(await db.checkpoint(id), checkpoint);
      assert.deepEqual(await views(), []);
      const archive = await pool.query("SELECT id FROM rpc_responses WHERE method = 'phase_getViewRecords'");
      assert.equal(archive.rowCount, 0);
      assert.equal((await pool.query("SELECT 1 FROM observation_index_results")).rowCount, 0);
    } finally {
      await pool.query("ALTER TABLE consensus_view_observations DROP CONSTRAINT reject_occurrence");
    }
    await collector.pollOnce();
    assert.equal((await db.checkpoint(id)).highViewId, "100");
  } finally {
    await mock.close();
  }
});

test("bounded backfill recovers empty responses, retains unsupported bodies, and resumes without duplicates", async () => {
  const mock = await mockPhase();
  try {
    const { id } = await boot(mock);
    const otherRpc = mock.rpc();
    const otherId = await db.registerSource("http://127.0.0.1:9009", await otherRpc.getIdentity());
    const input = [
      [id, 11, Buffer.from(fixture("live-order-11"))],
      [id, 7, Buffer.from('{"jsonrpc":"2.0","id":7,"result":[]}')],
      [otherId, 8, Buffer.from("unsupported payload")],
    ] as const;
    for (const [source, rpcId, body] of input) {
      const request = JSON.stringify({ id: rpcId, jsonrpc: "2.0", method: "phase_getViewRecords", params: [null, 60] });
      await pool.query(
        "INSERT INTO rpc_responses(source_id, method, purpose, request_body, response_body, observed_at) " +
        "VALUES($1, 'phase_getViewRecords', 'view_page', $2, $3, now())", [source, request, body],
      );
    }
    assert.equal((await inspectViewObservations(pool, id, "8294199")).status, "unknown");
    assert.deepEqual(await backfillObservations(pool, 1), { indexed: 1, unsupported: 0, occurrences: 60 });
    const sampled = await inspectViewObservations(pool, id, "8294199", 1);
    assert.equal(sampled.status, "unknown");
    assert.equal(sampled.coverage.truncated, true);
    const workers = await Promise.all([backfillObservations(pool, 10), backfillObservations(pool, 10)]);
    assert.equal(workers.reduce((n, row) => n + row.indexed, 0), 1);
    assert.equal(workers.reduce((n, row) => n + row.unsupported, 0), 1);
    assert.deepEqual(await backfillObservations(pool, 1), { indexed: 0, unsupported: 0, occurrences: 0 });
    assert.equal((await inspectViewObservations(pool, id, "8294199")).status, "unresolved");
    const isolated = await inspectViewObservations(pool, otherId, "8294199");
    assert.equal(isolated.status, "unknown");
    assert.equal(isolated.scannedOccurrences, 0);
    assert.equal(isolated.coverage.unsupported, true);
    const archive = await pool.query(
      "SELECT r.response_body, i.outcome, i.occurrence_count FROM rpc_responses r " +
      "JOIN observation_index_results i ON i.response_id=r.id ORDER BY r.id",
    );
    assert.deepEqual(archive.rows, [
      { response_body: input[0][2], outcome: "indexed", occurrence_count: 60 },
      { response_body: input[1][2], outcome: "indexed", occurrence_count: 0 },
      { response_body: input[2][2], outcome: "unsupported", occurrence_count: null },
    ]);
    assert.deepEqual(await views(), []);
    assert.equal((await db.checkpoint(id)).highViewId, null);
  } finally {
    await mock.close();
  }
});

test("backfill verifies existing occurrence contents before recording completion", async () => {
  const mock = await mockPhase();
  try {
    mock.setViews(wireView(100));
    const { collector } = await boot(mock);
    await collector.pollOnce();
    await pool.query("DELETE FROM observation_index_results");
    assert.deepEqual(await backfillObservations(pool, 1), { indexed: 1, unsupported: 0, occurrences: 1 });
    await pool.query("DELETE FROM observation_index_results");
    await pool.query("UPDATE consensus_view_observations SET normalized_record = '{}'");
    await assert.rejects(backfillObservations(pool, 1), /Conflicting indexed observations/);
    assert.equal((await pool.query("SELECT 1 FROM observation_index_results")).rowCount, 0);
  } finally {
    await mock.close();
  }
});

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
    const probe = await pool.query(
      "SELECT i.occurrence_count FROM observation_index_results i JOIN rpc_responses r ON r.id=i.response_id " +
      "WHERE r.purpose='retention_probe'",
    );
    assert.equal(probe.rows[0].occurrence_count, 10_000);
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
      "SELECT r.purpose,v.current_response_index FROM consensus_views v " +
      "JOIN rpc_responses r ON r.id=v.first_response_id WHERE view_id=102",
    );
    assert.deepEqual(proof.rows[0], { purpose: "retention_probe", current_response_index: 3 });
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
    const indexed = await pool.query(
      "SELECT i.occurrence_count FROM observation_index_results i JOIN rpc_responses r ON r.id=i.response_id " +
      "WHERE r.purpose='superseded_poll'",
    );
    assert.deepEqual(indexed.rows, [{ occurrence_count: 2 }]);
  } finally {
    await mock.close();
  }
});
