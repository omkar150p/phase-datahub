import type { CertificateStatus, ConsensusView } from "./phase-rpc.js";

export interface Observation {
  responseId: string;
  responseIndex: number;
  receiptMicros: string;
  record: ConsensusView;
}

interface EvidenceRef {
  responseId: string;
  responseIndex: number;
}

interface Finding {
  kind: string;
  severity: "unresolved" | "transition" | "informational";
  evidence: EvidenceRef[];
}

interface BlockContext {
  signerFacts: Map<CertificateStatus, { first: Observation; orders: Map<string, Observation> }>;
  certificates: Map<CertificateStatus, { first: Observation; latest: Observation }>;
}

function compareObservations(a: Observation, b: Observation): number {
  const timeDifference = BigInt(a.receiptMicros) - BigInt(b.receiptMicros);
  if (timeDifference !== 0n) return timeDifference < 0n ? -1 : 1;
  const idDifference = BigInt(a.responseId) - BigInt(b.responseId);
  return idDifference === 0n ? a.responseIndex - b.responseIndex : idDifference < 0n ? -1 : 1;
}

export function compareViewObservations(rows: Observation[], complete: boolean) {
  const findings = new Map<string, Finding>();
  function add(kind: string, severity: Finding["severity"], ...observations: Observation[]) {
    if (!findings.has(kind)) {
      findings.set(kind, {
        kind, severity,
        evidence: observations.map(({ responseId, responseIndex }) => ({ responseId, responseIndex })),
      });
    }
  }

  const contexts = new Map<string, {
    hashes: Map<CertificateStatus, Observation[]>;
    blocks: Map<string, BlockContext>;
  }>();
  const ordered = [...rows].sort(compareObservations);
  for (const row of ordered) {
    const record = row.record;
    const status = record.certificateStatus;
    const signerSet = new Set(record.signers);
    if (record.signerCount !== String(record.signers.length)) add("signer_count_mismatch", "unresolved", row);
    if (signerSet.size !== record.signers.length) add("duplicate_signer_indices", "unresolved", row);

    const contextKey = JSON.stringify([record.epoch, record.committeeRound, record.leaderIndex, record.members]);
    let context = contexts.get(contextKey);
    if (!context) {
      if (contexts.size > 0) add("view_context_variation", "unresolved", ordered[0]!, row);
      context = { hashes: new Map(), blocks: new Map() };
      contexts.set(contextKey, context);
    }

    const hash = record.blockHash;
    if (hash === null) continue;
    for (const [otherStatus, previous] of context.hashes) {
      const earlier = previous.find((item) => item.record.blockHash !== hash);
      if (!earlier) continue;
      if (otherStatus === status) add("same_status_hash_variation", "unresolved", earlier, row);
      else if (otherStatus !== "none" && status !== "none") {
        add("certificate_hash_variation", "unresolved", earlier, row);
      }
    }
    const representatives = context.hashes.get(status) ?? [];
    if (representatives.length < 2 && !representatives.some((item) => item.record.blockHash === hash)) {
      context.hashes.set(status, [...representatives, row]);
    }

    let block = context.blocks.get(hash);
    if (!block) {
      block = { signerFacts: new Map(), certificates: new Map() };
      context.blocks.set(hash, block);
    }
    let signers = block.signerFacts.get(status);
    if (!signers) {
      signers = { first: row, orders: new Map() };
      block.signerFacts.set(status, signers);
    }
    const membership = JSON.stringify([...signerSet].sort());
    const originalMembership = JSON.stringify([...new Set(signers.first.record.signers)].sort());
    if (membership !== originalMembership) add("signer_membership_variation", "unresolved", signers.first, row);
    if (record.signerCount !== signers.first.record.signerCount) {
      add("reported_signer_count_variation", "unresolved", signers.first, row);
    }
    if (record.blockHeight !== signers.first.record.blockHeight ||
        record.committeeSize !== signers.first.record.committeeSize || record.success !== signers.first.record.success) {
      add("same_status_metadata_variation", "unresolved", signers.first, row);
    }
    const previousOrder = signers.orders.get(membership);
    if (!previousOrder) signers.orders.set(membership, row);
    else if (previousOrder.record.signers.length === record.signers.length &&
             previousOrder.record.signers.some((signer, index) => signer !== record.signers[index]) &&
             JSON.stringify([...previousOrder.record.signers].sort()) === JSON.stringify([...record.signers].sort())) {
      add("signer_order_variation", "informational", previousOrder, row);
    }

    if (status === "none") continue;
    const opposite = block.certificates.get(status === "tentative" ? "full" : "tentative");
    if (opposite) {
      const earlier = opposite.latest.responseId === row.responseId ? opposite.latest : opposite.first;
      if (earlier.responseId !== row.responseId && earlier.receiptMicros === row.receiptMicros) {
        add("certificate_order_ambiguous", "unresolved", earlier, row);
      } else if (status === "full") {
        add("tentative_to_full_observed", "transition", earlier, row);
      } else {
        add("full_then_tentative_observed", "informational", earlier, row);
      }
    }
    const prior = block.certificates.get(status);
    block.certificates.set(status, { first: prior?.first ?? row, latest: row });
  }

  const values = [...findings.values()];
  const status = values.some((finding) => finding.severity === "unresolved") ? "unresolved"
    : !complete || rows.length === 0 ? "unknown"
    : values.some((finding) => finding.severity === "transition") ? "reported_transition"
    : "no_discrepancy_observed";
  return { status, findings: values };
}
