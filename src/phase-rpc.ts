import { setTimeout as delay } from "node:timers/promises";
import { isLosslessNumber, LosslessNumber, parse, stringify } from "lossless-json";
import pLimit from "p-limit";
import type { Log } from "./log.js";

export const VIEW_METHOD = "phase_getViewRecords";
export const MAX_VIEW_PAGE_SIZE = 10_000;
const MAX_RESPONSE_BYTES = 32 * 1024 * 1024;
export const MAX_UINT64 = 18_446_744_073_709_551_615n;
export const PHASE_CHAIN_ID = "1015";
export const PHASE_GENESIS = "0x50b453b2fc402366a4341b111cd63539676277199c34339f07a10e73f964e2f7";

export type HeadTag = "latest" | "finalized";
export type CertificateStatus = "none" | "tentative" | "full";

export interface ConsensusView {
  viewId: string;
  viewTimestampSecs: string;
  blockHeight: string | null;
  blockHash: string | null;
  epoch: string;
  committeeRound: string;
  leaderIndex: string;
  members: string[];
  signers: string[];
  signerCount: string;
  committeeSize: string;
  success: boolean;
  isTentative: boolean;
  certificateStatus: CertificateStatus;
}

export interface Head {
  height: string;
  hash: string;
  blockTimestampSecs: string;
}

export interface RpcEvidence {
  method: string;
  requestBody: string;
  rawResponse: Buffer;
  observedAt: Date;
}

export interface RpcResult<T> extends RpcEvidence {
  result: T;
}

export interface ViewPage extends RpcResult<ConsensusView[]> {
  wireCount: number;
  duplicateCount: number;
  outOfOrder: boolean;
}

interface RpcOptions {
  concurrency: number;
  timeoutMs: number;
  retries: number;
  backoffBaseMs: number;
  backoffMaxMs: number;
}

export type RpcFailureKind = "timeout" | "network" | "http" | "rate_limit" | "rpc" | "protocol";

export class RpcError extends Error {
  constructor(
    readonly kind: RpcFailureKind,
    message: string,
    readonly retryable = false,
    readonly code?: number,
    readonly retryAfterMs = 0,
  ) {
    super(message);
    this.name = "RpcError";
  }
}

function invalid(field: string): never {
  throw new RpcError("protocol", "Unexpected Phase RPC field " + field);
}

function object(value: unknown, field: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value) || isLosslessNumber(value)) {
    return invalid(field);
  }
  return value as Record<string, unknown>;
}

function uint(value: unknown, field: string): bigint {
  if (!isLosslessNumber(value) || !/^\d{1,20}$/.test(value.value)) return invalid(field);
  const result = BigInt(value.value);
  if (result > MAX_UINT64) return invalid(field);
  return result;
}

function hexUint(value: unknown, field: string): string {
  if (typeof value !== "string" || !/^0x(?:0|[1-9a-f][0-9a-f]{0,15})$/i.test(value)) return invalid(field);
  return BigInt(value).toString();
}

function hash(value: unknown, field: string): string {
  if (typeof value !== "string" || !/^0x[0-9a-f]{64}$/i.test(value)) return invalid(field);
  return value.toLowerCase();
}

function bool(value: unknown, field: string): boolean {
  if (typeof value !== "boolean") return invalid(field);
  return value;
}

function indices(value: unknown, field: string): string[] {
  if (!Array.isArray(value)) return invalid(field);
  return value.map((item) => uint(item, field).toString());
}

function normalizeView(value: unknown): ConsensusView {
  const row = object(value, "result[]");
  const success = bool(row.success, "success");
  const isTentative = bool(row.is_tentative, "is_tentative");
  return {
    viewId: uint(row.view, "view").toString(),
    viewTimestampSecs: uint(row.timestamp_secs, "timestamp_secs").toString(),
    blockHeight: row.block_height === null ? null : uint(row.block_height, "block_height").toString(),
    blockHash: row.block_hash === null ? null : hash(row.block_hash, "block_hash"),
    epoch: uint(row.epoch, "epoch").toString(),
    committeeRound: uint(row.committee_round, "committee_round").toString(),
    leaderIndex: uint(row.leader_index, "leader_index").toString(),
    members: indices(row.members, "members"),
    signers: indices(row.signers, "signers"),
    signerCount: uint(row.signer_count, "signer_count").toString(),
    committeeSize: uint(row.committee_size, "committee_size").toString(),
    success,
    isTentative,
    certificateStatus: isTentative ? "tentative" : success ? "full" : "none",
  };
}

const CERTIFICATE_RANK: Record<CertificateStatus, number> = { none: 0, tentative: 1, full: 2 };

function decodeViewPage(value: unknown, from: bigint | null, limit: number): Pick<
  ViewPage, "result" | "wireCount" | "duplicateCount" | "outOfOrder"
> {
  if (!Array.isArray(value) || value.length > limit) return invalid("result");
  const projected = new Map<bigint, ConsensusView>();
  let previous: bigint | undefined;
  let outOfOrder = false;

  for (const item of value) {
    const view = normalizeView(item);
    const id = BigInt(view.viewId);
    if (from !== null && id < from) return invalid("result fromView");
    if (previous !== undefined && id < previous) outOfOrder = true;
    previous = id;

    const prior = projected.get(id);
    const rank = CERTIFICATE_RANK[view.certificateStatus];
    if (!prior || rank > CERTIFICATE_RANK[prior.certificateStatus] ||
        (rank === CERTIFICATE_RANK[prior.certificateStatus] &&
          BigInt(view.viewTimestampSecs) >= BigInt(prior.viewTimestampSecs))) {
      projected.set(id, view);
    }
  }
  const result = [...projected].sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([, view]) => view);
  return { result, wireCount: value.length, duplicateCount: value.length - result.length, outOfOrder };
}

async function readResponseBody(response: Response): Promise<Buffer> {
  const stream = response.body;
  if (!stream) return Buffer.alloc(0);
  if (Number(response.headers.get("content-length")) > MAX_RESPONSE_BYTES) {
    await stream.cancel();
    throw new RpcError("protocol", "RPC response exceeds 32 MiB");
  }

  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    for (;;) {
      const chunk = await reader.read();
      if (chunk.done) return Buffer.concat(chunks, length);
      length += chunk.value.byteLength;
      if (length > MAX_RESPONSE_BYTES) {
        await reader.cancel();
        throw new RpcError("protocol", "RPC response exceeds 32 MiB");
      }
      chunks.push(chunk.value);
    }
  } finally {
    reader.releaseLock();
  }
}

function retryAfter(value: string | null): number {
  if (!value) return 0;
  const ms = /^\d+$/.test(value) ? Number(value) * 1_000 : Date.parse(value) - Date.now();
  return Number.isFinite(ms) ? Math.max(0, ms) : 0;
}

function decodeEnvelope(bytes: Buffer, id: number, retryAfterMs: number): unknown {
  let payload: unknown;
  try {
    payload = parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch {
    throw new RpcError("protocol", "Invalid UTF-8 JSON-RPC response");
  }
  const envelope = object(payload, "envelope");
  const responseId = envelope.id;
  const isError = Object.hasOwn(envelope, "error");

  if (envelope.jsonrpc !== "2.0" ||
      (!(isError && responseId === null) && uint(responseId, "id") !== BigInt(id))) {
    return invalid("envelope id or version");
  }
  if (Object.hasOwn(envelope, "result") === isError) return invalid("envelope result or error");
  if (!isError) return envelope.result;
  const error = object(envelope.error, "error");
  if (!isLosslessNumber(error.code) || !/^-?\d{1,10}$/.test(error.code.value) ||
      typeof error.message !== "string") return invalid("error code or message");

  const code = Number(error.code.value);
  const busy = code === -32005 || code === -32009;
  throw new RpcError(busy ? "rate_limit" : "rpc", error.message, busy, code, retryAfterMs);
}

export class PhaseRpc {
  readonly #limit;
  #id = 0;
  #notBefore = 0;

  constructor(readonly endpoint: string, private readonly options: RpcOptions, private readonly log: Log) {
    const url = new URL(endpoint);
    if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.search || url.hash) {
      throw new Error("Use an HTTP(S) RPC endpoint without embedded credentials, query, or fragment");
    }
    this.#limit = pLimit(options.concurrency);
  }

  async getIdentity(signal?: AbortSignal) {
    const chain = await this.#request("eth_chainId", [], signal);
    const genesis = await this.#request("eth_getBlockByNumber", ["0x0", false], signal);
    const header = object(genesis.result, "genesis result");
    const chainId = hexUint(chain.result, "chain id");
    const genesisHash = hash(header.hash, "genesis hash");
    if (hexUint(header.number, "genesis height") !== "0" ||
        chainId !== PHASE_CHAIN_ID || genesisHash !== PHASE_GENESIS) {
      throw new RpcError("protocol", "RPC does not match the documented Phase mainnet chain ID and genesis");
    }
    return { chainId, genesisHash, evidence: [chain, genesis] };
  }

  async getViews(from: bigint | null, limit: number, signal?: AbortSignal): Promise<ViewPage> {
    if ((from !== null && (from < 0n || from > MAX_UINT64)) ||
        !Number.isInteger(limit) || limit < 1 || limit > MAX_VIEW_PAGE_SIZE) {
      throw new RangeError("Invalid Phase view range");
    }
    const response = await this.#request(
      VIEW_METHOD, [from === null ? null : new LosslessNumber(from.toString()), limit], signal,
    );
    return { ...response, ...decodeViewPage(response.result, from, limit) };
  }

  async getHead(tag: HeadTag, signal?: AbortSignal): Promise<RpcResult<Head>> {
    const response = await this.#request("eth_getBlockByNumber", [tag, false], signal);
    const header = object(response.result, tag + " block");
    return {
      ...response,
      result: {
        height: hexUint(header.number, tag + " block number"),
        hash: hash(header.hash, tag + " block hash"),
        blockTimestampSecs: hexUint(header.timestamp, tag + " block timestamp"),
      },
    };
  }

  async #request(method: string, params: unknown[], signal?: AbortSignal): Promise<RpcResult<unknown>> {
    const id = ++this.#id;
    const requestBody = stringify({ jsonrpc: "2.0", id, method, params });
    if (requestBody === undefined) throw new Error("Could not encode RPC request");

    for (let attempt = 0; ; attempt += 1) {
      signal?.throwIfAborted();
      try {
        return await this.#limit(async () => {
          while (Date.now() < this.#notBefore) {
            signal?.throwIfAborted();
            await delay(Math.min(this.#notBefore - Date.now(), 2_147_483_647), undefined, { signal });
          }
          signal?.throwIfAborted();
          try {
            return await this.#attempt(method, id, requestBody, signal);
          } catch (error) {
            if (error instanceof RpcError && (error.kind === "rate_limit" || error.retryAfterMs > 0)) {
              const cooldown = Math.max(this.#retryDelay(attempt), error.retryAfterMs);
              this.#notBefore = Math.max(this.#notBefore, Date.now() + cooldown);
            }
            throw error;
          }
        });
      } catch (error) {
        signal?.throwIfAborted();
        if (!(error instanceof RpcError)) throw error;
        const willRetry = error.retryable && attempt < this.options.retries;
        this.log(willRetry ? "warn" : "error", "rpc_error", {
          endpoint: this.endpoint, method, attempt: attempt + 1, kind: error.kind, code: error.code,
          message: error.message, retryAfterMs: error.retryAfterMs, willRetry,
        });
        if (!willRetry) throw error;
        await delay(this.#retryDelay(attempt), undefined, { signal });
      }
    }
  }

  #retryDelay(attempt: number): number {
    const cap = Math.min(this.options.backoffMaxMs, this.options.backoffBaseMs * 2 ** attempt);
    return Math.max(1, Math.floor(cap * (0.5 + Math.random() * 0.5)));
  }

  async #attempt(method: string, id: number, requestBody: string, shutdown?: AbortSignal): Promise<RpcResult<unknown>> {
    const timeout = AbortSignal.timeout(this.options.timeoutMs);
    const signal = shutdown ? AbortSignal.any([shutdown, timeout]) : timeout;
    try {
      const response = await fetch(this.endpoint, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: requestBody,
        signal,
        redirect: "error",
      });
      const retryAfterMs = retryAfter(response.headers.get("retry-after"));
      if (!response.ok) {
        await response.body?.cancel();
        const status = response.status;
        throw new RpcError(
          status === 429 ? "rate_limit" : "http",
          "HTTP " + status,
          status === 408 || status === 429 || status >= 500,
          status,
          retryAfterMs,
        );
      }
      const rawResponse = await readResponseBody(response);
      const observedAt = new Date();
      return { method, requestBody, rawResponse, observedAt, result: decodeEnvelope(rawResponse, id, retryAfterMs) };
    } catch (error) {
      shutdown?.throwIfAborted();
      if (error instanceof RpcError) throw error;
      if (timeout.aborted) throw new RpcError("timeout", "RPC request timed out", true);
      throw new RpcError("network", error instanceof Error ? error.message : "RPC network failure", true);
    }
  }
}
