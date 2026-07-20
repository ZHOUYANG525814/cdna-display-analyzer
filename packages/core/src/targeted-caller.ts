import { translateDna } from "./dna.js";
import type { ResolvedTargetSite } from "./targeted-types.js";
import type { TargetedAlignment } from "./targeted-align.js";

export type TargetSiteCallStatus =
  | "wt"
  | "variant"
  | "stop_codon"
  | "target_insertion"
  | "target_deletion"
  | "low_quality"
  | "not_covered"
  | "ambiguous";

export interface TargetSiteCall {
  siteName: string;
  status: TargetSiteCallStatus;
  wtDna: string;
  wtAa: string | null;
  observedDna: string | null;
  observedAa: string | null;
  readPositions: number[];
  minBaseQ: number | null;
  meanBaseQ: number | null;
  /** Fixed-length, high-Q DNA call. Includes stop codons. */
  codonCallable: boolean;
}

export interface TargetSiteCallSettings {
  minBaseQ: number;
}

/** Call configured target intervals from a single full-reference alignment. */
export function callTargetSites(
  reference: Uint8Array,
  read: Uint8Array,
  qual: Uint8Array,
  alignment: TargetedAlignment,
  sites: ReadonlyArray<ResolvedTargetSite>,
  settings: TargetSiteCallSettings,
): TargetSiteCall[] {
  if (reference.length === 0) throw new Error("Reference is empty.");
  const refToRead = new Int32Array(reference.length);
  refToRead.fill(-1);
  const insertionAfter = new Set<number>();
  let refPos = 0;
  let readPos = alignment.readStart;
  let firstAlignedRef = reference.length;
  let lastAlignedRef = -1;

  for (const op of alignment.cigar) {
    if (op.code === "M" || op.code === "X") {
      for (let k = 0; k < op.length; k++) {
        if (refPos >= reference.length || readPos >= read.length) {
          throw new Error("Alignment CIGAR exceeds sequence bounds.");
        }
        refToRead[refPos] = readPos;
        if (refPos < firstAlignedRef) firstAlignedRef = refPos;
        if (refPos > lastAlignedRef) lastAlignedRef = refPos;
        refPos++;
        readPos++;
      }
    } else if (op.code === "I") {
      insertionAfter.add(refPos - 1);
      readPos += op.length;
    } else {
      refPos += op.length;
    }
  }
  if (refPos !== reference.length) {
    throw new Error(`CIGAR consumed ${refPos} reference bases; expected ${reference.length}.`);
  }

  return sites.map((site) => {
    if (site.start0 < firstAlignedRef || site.end0 - 1 > lastAlignedRef) {
      return emptyCall(site, "not_covered");
    }
    for (let boundary = site.start0; boundary < site.end0 - 1; boundary++) {
      if (insertionAfter.has(boundary)) return emptyCall(site, "target_insertion");
    }

    const positions: number[] = [];
    for (let p = site.start0; p < site.end0; p++) {
      const mapped = refToRead[p]!;
      if (mapped < 0) return emptyCall(site, "target_deletion");
      positions.push(mapped);
    }
    if (positions.some((p) => p >= qual.length || p >= read.length)) {
      return emptyCall(site, "not_covered");
    }

    const dna = positions.map((p) => String.fromCharCode(read[p]!)).join("").toUpperCase();
    if (/[^ACGT]/.test(dna)) {
      return {
        ...emptyCall(site, "ambiguous"),
        observedDna: dna,
        readPositions: positions,
      };
    }
    const qs = positions.map((p) => Math.max(0, qual[p]! - 33));
    const minBaseQ = Math.min(...qs);
    const meanBaseQ = qs.reduce((a, b) => a + b, 0) / qs.length;
    const aa = site.length % 3 === 0 ? translateDna(dna) : null;
    if (minBaseQ < settings.minBaseQ) {
      return makeCall(site, "low_quality", dna, aa, positions, minBaseQ, meanBaseQ, false);
    }
    if (dna === site.wtDna) {
      return makeCall(site, "wt", dna, aa, positions, minBaseQ, meanBaseQ, true);
    }
    if (aa?.includes("*")) {
      // Keep a complete, high-quality stop call visible instead of silently
      // deleting an observed state. No library-construction model is assumed.
      return makeCall(site, "stop_codon", dna, aa, positions, minBaseQ, meanBaseQ, true);
    }
    return makeCall(site, "variant", dna, aa, positions, minBaseQ, meanBaseQ, true);
  });
}

export function buildTargetHaplotype(calls: ReadonlyArray<TargetSiteCall>): string | null {
  if (calls.length === 0 || calls.some((c) => !c.codonCallable || c.observedDna == null)) return null;
  return calls.map((c) => c.observedDna).join("|");
}

function emptyCall(site: ResolvedTargetSite, status: TargetSiteCallStatus): TargetSiteCall {
  return {
    siteName: site.name,
    status,
    wtDna: site.wtDna,
    wtAa: site.wtAa,
    observedDna: null,
    observedAa: null,
    readPositions: [],
    minBaseQ: null,
    meanBaseQ: null,
    codonCallable: false,
  };
}

function makeCall(
  site: ResolvedTargetSite,
  status: TargetSiteCallStatus,
  dna: string,
  aa: string | null,
  positions: number[],
  minBaseQ: number,
  meanBaseQ: number,
  codonCallable: boolean,
): TargetSiteCall {
  return {
    siteName: site.name,
    status,
    wtDna: site.wtDna,
    wtAa: site.wtAa,
    observedDna: dna,
    observedAa: aa,
    readPositions: positions,
    minBaseQ,
    meanBaseQ,
    codonCallable,
  };
}

/** Build the protected mask once per run. 1=protected, 0=target. */
export function buildProtectedMask(
  referenceLength: number,
  sites: ReadonlyArray<ResolvedTargetSite>,
): Uint8Array {
  const mask = new Uint8Array(referenceLength);
  mask.fill(1);
  for (const site of sites) mask.fill(0, site.start0, site.end0);
  return mask;
}
