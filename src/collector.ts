import { setTimeout as delay } from "node:timers/promises";
import { DEFAULT_ENDPOINT } from "./config.js";
import { ArchiveDatabase } from "./database.js";
import { errorFields, type Log } from "./log.js";
import { MAX_UINT64, MAX_VIEW_PAGE_SIZE, PhaseRpc, type HeadTag } from "./phase-rpc.js";

export interface CollectorOptions {
  batchSize: number;
  overlapViews: number;
  pollIntervalMs: number;
  catchupIntervalMs: number;
  observationGapMs: number;
  retentionProbeIntervalMs: number;
  headIntervalMs: number;
}

export class Collector {
  #skipOverlapAt: string | undefined;

  constructor(
    readonly sourceId: number,
    private readonly rpc: PhaseRpc,
    private readonly db: ArchiveDatabase,
    private readonly options: CollectorOptions,
    private readonly log: Log,
  ) {
    if (!Number.isInteger(options.overlapViews) || !Number.isInteger(options.batchSize) ||
        options.overlapViews < 0 || options.batchSize <= options.overlapViews || options.batchSize > MAX_VIEW_PAGE_SIZE) {
      throw new RangeError("Collector requires 0 <= overlapViews < batchSize <= 10000");
    }
  }

  async pollOnce(signal?: AbortSignal) {
    signal?.throwIfAborted();
    const checkpoint = await this.db.checkpoint(this.sourceId);
    const skipOverlap = checkpoint.highViewId === this.#skipOverlapAt;
    const from = this.#nextFrom(checkpoint.highViewId, skipOverlap);
    const page = await this.rpc.getViews(from, this.options.batchSize, signal);
    const first = page.result[0];
    const leadingGap = checkpoint.highViewId !== null && first !== undefined &&
      BigInt(first.viewId) > BigInt(checkpoint.highViewId) + 1n;
    const probeDue = !checkpoint.lastRetentionProbeAt ||
      Date.now() - checkpoint.lastRetentionProbeAt.getTime() >= this.options.retentionProbeIntervalMs;
    let probe;
    if (from !== null && (leadingGap || (probeDue && await this.db.hasCandidateGaps(this.sourceId)))) {
      try {
        // An older view can appear after a newer one in the wire order.
        probe = await this.rpc.getViews(null, MAX_VIEW_PAGE_SIZE, signal);
      } catch (error) {
        signal?.throwIfAborted();
        this.log("warn", "retention_probe_failed", { sourceId: this.sourceId, ...errorFields(error) });
      }
    }

    signal?.throwIfAborted();
    const retention = probe && {
      page: probe,
      complete: probe.wireCount < MAX_VIEW_PAGE_SIZE || new URL(this.rpc.endpoint).href === DEFAULT_ENDPOINT + "/",
    };
    const state = await this.db.commitPoll(
      this.sourceId, checkpoint.revision, page, retention, this.options.observationGapMs,
    );
    const full = page.wireCount === this.options.batchSize;
    const advanced = state.highViewId !== checkpoint.highViewId;
    const repage = state.committed && full && !advanced && !skipOverlap &&
      this.options.overlapViews > 0 && state.highViewId !== null && BigInt(state.highViewId) < MAX_UINT64;
    this.#skipOverlapAt = repage ? (state.highViewId ?? undefined) : undefined;
    this.log("info", state.committed ? "collector_page_committed" : "collector_poll_superseded", {
      sourceId: this.sourceId, fromView: from?.toString() ?? null, records: page.result.length,
      wireRecords: page.wireCount, repeatedViews: page.duplicateCount, outOfOrder: page.outOfOrder,
      highViewId: state.highViewId,
      retentionFloor: retention?.complete ? retention.page.result[0]?.viewId ?? null : null,
    });
    return { ...state, records: page.result.length, catchup: state.committed && full && (advanced || repage) };
  }

  async observeHeads(signal?: AbortSignal): Promise<void> {
    const tags: HeadTag[] = ["latest", "finalized"];
    await Promise.all(tags.map(async (tag) => {
      try {
        const head = await this.rpc.getHead(tag, signal);
        signal?.throwIfAborted();
        await this.db.archiveHead(this.sourceId, tag, head);
      } catch (error) {
        if (!signal?.aborted) this.log("warn", "head_observation_failed", {
          sourceId: this.sourceId, tag, ...errorFields(error),
        });
      }
    }));
  }

  async run(signal: AbortSignal): Promise<void> {
    let nextHeadAt = 0;
    while (!signal.aborted) {
      let interval = this.options.pollIntervalMs;
      try {
        const page = await this.pollOnce(signal);
        if (page.catchup) {
          interval = this.options.catchupIntervalMs;
        }
      } catch (error) {
        if (signal.aborted) break;
        this.log("error", "collector_poll_failed", { sourceId: this.sourceId, ...errorFields(error) });
      }

      if (!signal.aborted && Date.now() >= nextHeadAt) {
        await this.observeHeads(signal);
        nextHeadAt = Date.now() + this.options.headIntervalMs;
      }
      if (signal.aborted) break;
      try {
        await delay(interval, undefined, { signal });
      } catch (error) {
        if (!signal.aborted) throw error;
      }
    }
  }

  #nextFrom(highViewId: string | null, skipOverlap: boolean): bigint | null {
    if (highViewId === null) return null;
    const target = BigInt(highViewId) + 1n - BigInt(skipOverlap ? 0 : this.options.overlapViews);
    return target < 0n ? 0n : target > MAX_UINT64 ? MAX_UINT64 : target;
  }
}
