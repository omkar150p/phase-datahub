import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { once } from "node:events";
import { test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { compareViewObservations, type Observation } from "../src/observation-findings.js";
import { decodeArchivedViewOccurrences, MAX_UINT64, RpcError } from "../src/phase-rpc.js";
import { fixture, mockServer, reply, wireView } from "./support.js";

function observations(overrides: Record<string, unknown>[], responseId = "1", receiptMicros = "100"): Observation[] {
  const request = JSON.stringify({ jsonrpc: "2.0", id: 1, method: "phase_getViewRecords", params: [null, 20] });
  const result = overrides.map((fields) => wireView(100, { signers: [1, 2], signer_count: 2, ...fields }));
  const response = Buffer.from(JSON.stringify({ jsonrpc: "2.0", id: 1, result }));
  return decodeArchivedViewOccurrences(request, response).map((entry) => ({ ...entry, responseId, receiptMicros }));
}

test("comparison distinguishes identical facts, permutations and actual signer discrepancies", () => {
  const identical = observations([{}, {}]);
  assert.deepEqual(compareViewObservations(identical, true), { status: "no_discrepancy_observed", findings: [] });
  const permutations = compareViewObservations(observations([{}, { signers: [2, 1] }]), true);
  assert.equal(permutations.status, "no_discrepancy_observed");
  assert.equal(permutations.findings[0]?.kind, "signer_order_variation");
  const differences = compareViewObservations(
    observations([{}, { signers: [1, 3], signer_count: 3 }, { signers: [1, 1] }]), false,
  );
  assert.equal(differences.status, "unresolved");
  assert.deepEqual(new Set(differences.findings.map(({ kind }) => kind)), new Set([
    "signer_membership_variation", "reported_signer_count_variation", "signer_count_mismatch", "duplicate_signer_indices",
  ]));
});

test("comparison scopes committee context, block hashes and certificate ordering", () => {
  const context = compareViewObservations(observations([{}, { committee_round: 1, signers: [3, 4] }]), true);
  assert.deepEqual(context.findings.map(({ kind }) => kind), ["view_context_variation"]);
  const hash = "0x" + "a".repeat(64);
  const changed = compareViewObservations(observations([{}, { block_hash: hash }, { is_tentative: true }]), true);
  assert.deepEqual(new Set(changed.findings.map(({ kind }) => kind)), new Set([
    "same_status_hash_variation", "certificate_hash_variation", "full_then_tentative_observed",
  ]));
  const metadata = compareViewObservations(observations([{}, { block_height: 123 }]), true);
  assert.equal(metadata.findings[0]?.kind, "same_status_metadata_variation");
  assert.equal(metadata.status, "unresolved");
  const transition = compareViewObservations(observations([{ is_tentative: true }, {}]), true);
  assert.equal(transition.status, "reported_transition");
  assert.equal(transition.findings[0]?.kind, "tentative_to_full_observed");
  const tied = compareViewObservations(
    [...observations([{ is_tentative: true }]), ...observations([{}], "2")], true,
  );
  assert.equal(tied.status, "unresolved");
  assert.equal(tied.findings[0]?.kind, "certificate_order_ambiguous");
});

test("captured RPC responses match their manifest", () => {
  const directory = new URL("../../fixtures/phase-mainnet/", import.meta.url);
  const manifest = JSON.parse(readFileSync(new URL("manifest.json", directory), "utf8")) as {
    file: string;
    sha256: string;
    request: { id: number };
  }[];
  assert.ok(Array.isArray(manifest) && manifest.length > 0);
  const files = new Set<string>();
  for (const entry of manifest) {
    assert.match(entry.file, /^[a-z0-9-]+\.json$/);
    assert.ok(!files.has(entry.file), "duplicate capture " + entry.file);
    files.add(entry.file);
    const body = readFileSync(new URL(entry.file, directory));
    const sha256 = createHash("sha256").update(body).digest("hex");
    assert.equal(sha256, entry.sha256, entry.file);
    assert.equal(JSON.parse(body.toString("utf8")).id, entry.request.id, entry.file);
  }
});

test("decodes byte-for-byte live Phase view fixture with independent signer fields", async () => {
  const wire = fixture("view-range");
  const mock = await mockServer(({ id }, res) => { res.end(wire.replace('"id":4', '"id":' + id)); });
  try {
    const response = await mock.rpc().getViews(8289719n, 3);
    assert.deepEqual(response.rawResponse, Buffer.from(wire.replace('"id":4', '"id":1')));
    assert.deepEqual(response.result.map((row) => row.viewId), ["8289719", "8289720", "8289721"]);
    assert.equal(response.result[0]!.blockHeight, "8275247");
    assert.equal(response.result[0]!.signerCount, "10");
    assert.deepEqual(response.result[0]!.signers, ["9", "12", "22", "29", "137", "143", "208", "66", "62", "179"]);
    assert.equal(response.result[0]!.certificateStatus, "full");
  } finally {
    await mock.close();
  }
});

test("signer count and array are preserved independently when the source disagrees", async () => {
  const mock = await mockServer(({ id }, res) => {
    reply(res, id, [wireView(99, { signers: [9, 12], signer_count: 10 })]);
  });
  try {
    const view = (await mock.rpc().getViews(null, 1)).result[0]!;
    assert.equal(view.signerCount, "10");
    assert.deepEqual(view.signers, ["9", "12"]);
  } finally {
    await mock.close();
  }
});

test("empty JSON-RPC result is a valid page", async () => {
  const wire = fixture("future-cursor-empty");
  const mock = await mockServer(({ id }, res) => { res.end(wire.replace('"id":8', '"id":' + id)); });
  try {
    assert.deepEqual((await mock.rpc().getViews(9_000_000_000_000n, 1)).result, []);
  } finally {
    await mock.close();
  }
});

test("uint64 view IDs are sent as exact JSON numbers and normalized as decimal strings", async () => {
  const mock = await mockServer(({ id, body }, res) => {
    assert.match(body, /"params":\[18446744073709551615,1\]/);
    const response = JSON.stringify({ jsonrpc: "2.0", id, result: [wireView(991, { block_height: 992 })] });
    res.end(response.replace('"view":991', '"view":18446744073709551615')
      .replace('"block_height":992', '"block_height":9007199254740993'));
  });
  try {
    const response = await mock.rpc().getViews(MAX_UINT64, 1);
    assert.equal(response.result[0]!.viewId, "18446744073709551615");
    assert.equal(response.result[0]!.blockHeight, "9007199254740993");
  } finally {
    await mock.close();
  }
});

test("the two captured live pages preserve repeated wire records and project one ordered view each", async () => {
  const samples = [
    { fixtureId: 11, from: null, repeated: 2, viewId: "8294199", signerCount: "9" },
    { fixtureId: 12, from: 8294779n, repeated: 4, viewId: "8294814", signerCount: "11" },
  ];
  for (const sample of samples) {
    const wire = fixture("live-order-" + sample.fixtureId);
    const rawFor = (id: number) => wire.replace('"id":' + sample.fixtureId, '"id":' + id);
    const mock = await mockServer(({ id }, res) => { res.end(rawFor(id)); });
    try {
      const response = await mock.rpc().getViews(sample.from, 60);
      assert.deepEqual(response.rawResponse, Buffer.from(rawFor(1)));
      assert.equal(response.wireCount, 60);
      assert.equal(response.duplicateCount, sample.repeated);
      assert.equal(response.result.length, 60 - sample.repeated);
      assert.equal(response.outOfOrder, true);
      assert.ok(response.result.every((item, i) => i === 0 ||
        BigInt(response.result[i - 1]!.viewId) < BigInt(item.viewId)));
      assert.equal(response.result.find((view) => view.viewId === sample.viewId)?.signerCount, sample.signerCount);
    } finally {
      await mock.close();
    }
  }
});

test("malformed or cursor-inconsistent pages are rejected", async () => {
  const inputs = [
    [wireView(15, { timestamp_secs: "100" })],
    [wireView(9)],
  ];
  const mock = await mockServer(({ id }, res) => { reply(res, id, inputs.shift()); });
  try {
    const rpc = mock.rpc();
    for (let i = 0; i < 2; i += 1) {
      await assert.rejects(rpc.getViews(10n, 10), (error) => error instanceof RpcError && error.kind === "protocol");
    }
  } finally {
    await mock.close();
  }
});

test("wrong genesis is rejected even when the chain ID matches", async () => {
  const mock = await mockServer(({ id, method }, res) => {
    reply(res, id, method === "eth_chainId" ? "0x3f7" : { number: "0x0", hash: "0x" + "0".repeat(64) });
  });
  try {
    await assert.rejects(mock.rpc().getIdentity(), /chain ID and genesis/);
  } finally {
    await mock.close();
  }
});

test("RPC timeout retries within the configured budget and produces structured logs", async () => {
  const events: Record<string, unknown>[] = [];
  const mock = await mockServer(async (_request, res) => {
    await once(res, "close");
  });
  try {
    const rpc = mock.rpc({ timeoutMs: 100, retries: 1 }, (_level, event, fields) => {
      if (event === "rpc_error" && fields) events.push(fields);
    });
    await assert.rejects(rpc.getViews(null, 1), (error) => error instanceof RpcError && error.kind === "timeout");
    assert.deepEqual(events.map(({ kind, willRetry }) => [kind, willRetry]), [["timeout", true], ["timeout", false]]);
  } finally {
    await mock.close();
  }
});

test("HTTP 429 and Phase server-busy errors use retry handling", async () => {
  let requests = 0;
  const codes: unknown[] = [];
  const arrivals: number[] = [];
  const mock = await mockServer(({ id }, res) => {
    requests += 1;
    arrivals.push(Date.now());
    if (requests === 1) {
      res.writeHead(429, { "retry-after": "1" });
      res.end();
    } else if (requests < 4) {
      res.end(JSON.stringify({ jsonrpc: "2.0", id, error: {
        code: requests === 2 ? -32005 : -32009, message: "busy",
      }}));
    } else {
      reply(res, id, []);
    }
  });
  try {
    const result = await mock.rpc({ retries: 3 }, (_level, event, fields) => {
      if (event === "rpc_error") codes.push(fields?.code);
    }).getViews(null, 1);
    assert.deepEqual(codes, [429, -32005, -32009]);
    assert.ok(arrivals[1]! - arrivals[0]! >= 950, "honors Retry-After before the next request");
    assert.deepEqual(result.result, []);
  } finally {
    await mock.close();
  }
});

test("an oversized response is rejected before its body is buffered", async () => {
  const mock = await mockServer(async (_request, res) => {
    res.writeHead(200, { "content-length": String(33 * 1024 * 1024) });
    res.flushHeaders();
    await once(res, "close");
  });
  try {
    await assert.rejects(mock.rpc().getViews(null, 1), {
      kind: "protocol", message: "RPC response exceeds 32 MiB",
    });
  } finally {
    await mock.close();
  }
});

test("configured concurrency bounds simultaneous requests", async () => {
  let active = 0;
  let peak = 0;
  const mock = await mockServer(async ({ id }, res) => {
    peak = Math.max(peak, ++active);
    await delay(35);
    active -= 1;
    reply(res, id, []);
  });
  try {
    const rpc = mock.rpc({ concurrency: 2 });
    await Promise.all(Array.from({ length: 5 }, () => rpc.getViews(null, 1)));
    assert.equal(peak, 2);
  } finally {
    await mock.close();
  }
});

test("graceful abort cancels in-flight RPC without retries", async () => {
  let started!: () => void;
  const waiting = new Promise<void>((resolve) => { started = resolve; });
  const mock = await mockServer(async (_request, res) => {
    started();
    await once(res, "close");
  });
  try {
    const controller = new AbortController();
    const result = mock.rpc({ retries: 2 }).getViews(null, 1, controller.signal);
    await waiting;
    controller.abort();
    await assert.rejects(result, { name: "AbortError" });
    assert.equal(mock.requests.length, 1);
  } finally {
    await mock.close();
  }
});
