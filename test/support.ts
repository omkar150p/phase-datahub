import { createServer } from "node:http";
import { readFileSync } from "node:fs";
import { setTimeout as delay } from "node:timers/promises";
import type { AddressInfo } from "node:net";
import type { ServerResponse } from "node:http";
import { PhaseRpc } from "../src/phase-rpc.js";
import type { Log } from "../src/log.js";

export const quiet: Log = () => undefined;
export const rpcOptions = { concurrency: 1, timeoutMs: 2_000, retries: 0, backoffBaseMs: 5, backoffMaxMs: 30 };

export interface MockRequest {
  id: number;
  method: string;
  params: unknown[];
  body: string;
}

export function fixture(name: string): string {
  return readFileSync(new URL("../../fixtures/phase-mainnet/" + name + ".json", import.meta.url), "utf8");
}

export function fixtureResult(name: string): unknown {
  return JSON.parse(fixture(name)).result;
}

const viewTemplate = (fixtureResult("view-range") as { view: number }[])[0]!;

export function wireView(view: number, overrides: Record<string, unknown> = {}) {
  return { ...viewTemplate, view, ...overrides };
}
export type WireView = ReturnType<typeof wireView>;

export function reply(res: ServerResponse, id: number, result: unknown): string {
  const bytes = JSON.stringify({ jsonrpc: "2.0", id, result });
  res.setHeader("content-type", "application/json");
  res.end(bytes);
  return bytes;
}

export async function mockServer(handler: (request: MockRequest, res: ServerResponse) => void | Promise<void>) {
  const errors: unknown[] = [];
  const requests: MockRequest[] = [];
  const server = createServer(async (req, res) => {
    try {
      const chunks = [];
      for await (const chunk of req) chunks.push(chunk as Buffer);
      const body = Buffer.concat(chunks).toString();
      const request: MockRequest = { ...JSON.parse(body), body };
      requests.push(request);
      await handler(request, res);
    } catch (error) {
      errors.push(error);
      if (!res.headersSent) res.writeHead(500);
      res.end();
    }
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const endpoint = "http://127.0.0.1:" + (server.address() as AddressInfo).port;
  return {
    endpoint, requests,
    rpc: (options: Partial<typeof rpcOptions> = {}, log: Log = quiet) =>
      new PhaseRpc(endpoint, { ...rpcOptions, ...options }, log),
    async close() {
      const closed = new Promise<void>((resolve, reject) =>
        server.close((error) => error ? reject(error) : resolve()));
      server.closeAllConnections();
      await closed;
      if (errors.length) throw new AggregateError(errors, "Mock Phase server handler failed");
    },
  };
}

export async function mockPhase() {
  let views: WireView[] = [];
  let latencyMs = 0;
  let emptyFloorProbe = false;
  const server = await mockServer(async ({ id, method, params }, res) => {
    if (latencyMs && method === "phase_getViewRecords") await delay(latencyMs);
    switch (method) {
      case "eth_chainId":
        reply(res, id, fixtureResult("chain-id"));
        return;
      case "eth_getBlockByNumber": {
        const fixtureName = params[0] === "0x0" ? "genesis-block" : String(params[0]) + "-block";
        reply(res, id, fixtureResult(fixtureName));
        return;
      }
      case "phase_getViewRecords": {
        const from = params[0] === null ? 0 : Number(params[0]);
        const limit = Number(params[1]);
        const result = emptyFloorProbe && params[0] === null && limit === 10_000
          ? []
          : views.filter((view) => view.view >= from).slice(0, limit);
        reply(res, id, result);
        return;
      }
      default:
        throw new Error("Unexpected request " + method);
    }
  });

  return {
    ...server,
    setViews: (...records: WireView[]) => { views = records; },
    setLatency: (ms: number) => { latencyMs = ms; },
    setEmptyFloorProbe: () => { emptyFloorProbe = true; },
  };
}
