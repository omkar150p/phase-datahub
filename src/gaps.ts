export type GapState = "candidate_sequence_gap" | "unrecoverable_from_source";

export interface Range {
  first: bigint;
  last: bigint;
}

export function newSequenceGaps(high: bigint | null, ids: readonly bigint[]): Range[] {
  const gaps: Range[] = [];
  let previous = high;
  for (const id of ids) {
    if (previous !== null && id <= previous) continue;
    if (previous !== null && id > previous + 1n) {
      gaps.push({ first: previous + 1n, last: id - 1n });
    }
    previous = id;
  }
  return gaps;
}

export function removeObserved(range: Range, ids: readonly bigint[]): Range[] {
  const remaining: Range[] = [];
  let first = range.first;
  for (const id of ids) {
    if (id < first) continue;
    if (id > range.last) break;
    if (id > first) remaining.push({ first, last: id - 1n });
    first = id + 1n;
  }
  if (first <= range.last) remaining.push({ first, last: range.last });
  return remaining;
}

export function classifyRanges(ranges: readonly Range[], state: GapState, floor: bigint | null) {
  return ranges.flatMap((range): (Range & { state: GapState })[] => {
    if (state === "unrecoverable_from_source" || floor === null || range.first >= floor) {
      return [{ ...range, state }];
    }
    if (range.last < floor) return [{ ...range, state: "unrecoverable_from_source" }];
    return [
      { first: range.first, last: floor - 1n, state: "unrecoverable_from_source" },
      { first: floor, last: range.last, state: "candidate_sequence_gap" },
    ];
  });
}
