import type {
  DriveFileRef,
  NanoporeOutcome,
  PipelineOutcome,
  TargetedNanoporeOutcome,
} from "../worker/types";

export interface LabeledLocalFastq {
  file: File;
  label: string;
}

export interface LabeledDriveFastq {
  file: DriveFileRef;
  label: string;
}

/** Detect duplicate inputs without reading whole multi-GB FASTQs.
 *
 * Local identity uses SHA-256 over file size plus the first/last 64 KiB.
 * This detects the same physical content even when a new File object or a
 * renamed copy is selected, while allowing same-name shards with different
 * content. Drive has a stable file ID and does not need content sampling.
 */
export async function findDuplicateFastqGroups(
  local: ReadonlyArray<LabeledLocalFastq>,
  drive: ReadonlyArray<LabeledDriveFastq>,
): Promise<string[][]> {
  const labelsByKey = new Map<string, string[]>();
  const add = (key: string, label: string): void => {
    labelsByKey.set(key, [...(labelsByKey.get(key) ?? []), label]);
  };
  for (const source of local) {
    add(`local:${await sampledLocalFingerprint(source.file)}`, source.label);
  }
  for (const source of drive) add(`drive:${source.file.id}`, source.label);
  return [...labelsByKey.values()].filter((labels) => labels.length > 1);
}

export function cdnaZeroCoverage(outcome: PipelineOutcome): string[] {
  return outcome.roundNames.flatMap((round) =>
    (outcome.statsByRound[round]?.passed_qc ?? 0) > 0 ? [] : [round],
  );
}

export function nanoporeZeroCoverage(
  outcome: NanoporeOutcome,
  requireLinkedCombinations: boolean,
): string[] {
  const issues: string[] = [];
  for (const round of outcome.roundNames) {
    const stats = outcome.statsByRound[round];
    for (const site of outcome.siteNames) {
      if ((stats?.sites[site]?.passed_qc ?? 0) === 0) {
        issues.push(`${round} / ${site}`);
      }
    }
    if (
      requireLinkedCombinations &&
      outcome.siteNames.length >= 2 &&
      (stats?.haplotype_passed_qc ?? 0) === 0
    ) {
      issues.push(`${round} / linked combinations`);
    }
  }
  return issues;
}

export function targetedZeroCoverage(
  outcome: TargetedNanoporeOutcome,
  requireLinkedCombinations: boolean,
): string[] {
  const issues: string[] = [];
  for (const round of outcome.roundNames) {
    const stats = outcome.statsByRound[round];
    for (const site of outcome.siteNames) {
      if ((stats?.sites[site]?.passed_qc ?? 0) === 0) {
        issues.push(`${round} / ${site}`);
      }
    }
    if (
      requireLinkedCombinations &&
      outcome.siteNames.length >= 2 &&
      (stats?.haplotype_passed_qc ?? 0) === 0
    ) {
      issues.push(`${round} / linked combinations`);
    }
  }
  return issues;
}

export function zeroCoverageMessage(issues: ReadonlyArray<string>): string {
  return (
    "Run rejected: zero effective coverage for " +
    issues.join(", ") +
    ". Enrichment was not accepted because at least one required denominator is zero."
  );
}

async function sampledLocalFingerprint(file: File): Promise<string> {
  const sampleBytes = 64 * 1024;
  const headLength = Math.min(file.size, sampleBytes);
  const head = new Uint8Array(await file.slice(0, headLength).arrayBuffer());
  const tail =
    file.size > sampleBytes
      ? new Uint8Array(
          await file.slice(Math.max(headLength, file.size - sampleBytes)).arrayBuffer(),
        )
      : new Uint8Array(0);
  const sizePrefix = new TextEncoder().encode(`${file.size}:`);
  const payload = new Uint8Array(sizePrefix.length + head.length + tail.length);
  payload.set(sizePrefix);
  payload.set(head, sizePrefix.length);
  payload.set(tail, sizePrefix.length + head.length);
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", payload));
  return [...digest].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}
