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

export interface FastqDuplicateCheck {
  /** Certain duplicates: the identical File object or identical Drive ID. */
  exactGroups: string[][];
  /** Same size + sampled head/tail SHA-256. This is deliberately not called a
   * full content hash and must be confirmed by the user rather than blocked. */
  probableGroups: string[][];
}

/** Detect exact and probable duplicate inputs without reading whole FASTQs. */
export async function findDuplicateFastqGroups(
  local: ReadonlyArray<LabeledLocalFastq>,
  drive: ReadonlyArray<LabeledDriveFastq>,
): Promise<FastqDuplicateCheck> {
  const exactLabels = new Map<object | string, string[]>();
  const addExact = (key: object | string, label: string): void => {
    exactLabels.set(key, [...(exactLabels.get(key) ?? []), label]);
  };
  for (const source of local) addExact(source.file, source.label);
  for (const source of drive) addExact(`drive:${source.file.id}`, source.label);

  const probableLabels = new Map<string, string[]>();
  for (const source of local) {
    const key = await sampledLocalFingerprint(source.file);
    probableLabels.set(key, [...(probableLabels.get(key) ?? []), source.label]);
  }
  return {
    exactGroups: [...exactLabels.values()].filter((labels) => labels.length > 1),
    probableGroups: [...probableLabels.values()].filter((labels) => labels.length > 1),
  };
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
