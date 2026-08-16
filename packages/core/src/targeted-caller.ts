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

export interface TargetedReadProjection {
  readonly refToRead: Int32Array;
  /** CIGAR state by reference base: 1=M, 2=X, 3=D, 0=not aligned. */
  readonly opAtRef: Uint8Array;
  /** Inserted base count immediately before this reference position. */
  readonly insertionBefore: Uint32Array;
  readonly firstAlignedRef: number;
  readonly lastAlignedRef: number;
}

export interface TargetedProjectionWorkspace {
  readonly refToRead: Int32Array;
  readonly opAtRef: Uint8Array;
  readonly insertionBefore: Uint32Array;
}

export function createTargetedProjectionWorkspace(referenceLength: number): TargetedProjectionWorkspace {
  return {
    refToRead: new Int32Array(referenceLength),
    opAtRef: new Uint8Array(referenceLength),
    insertionBefore: new Uint32Array(referenceLength + 1),
  };
}

/** Build the reference→read projection once and reuse its fixed buffers for
 * global QC consumers, local rescue, target calls and haplotypes. */
export function buildTargetedReadProjection(
  referenceLength: number,
  readLength: number,
  alignment: TargetedAlignment,
  workspace: TargetedProjectionWorkspace = createTargetedProjectionWorkspace(referenceLength),
): TargetedReadProjection {
  if (workspace.refToRead.length !== referenceLength) {
    throw new Error("Projection workspace length does not match the reference.");
  }
  workspace.refToRead.fill(-1);
  workspace.opAtRef.fill(0);
  workspace.insertionBefore.fill(0);
  let refPos = 0;
  let readPos = alignment.readStart;
  let firstAlignedRef = referenceLength;
  let lastAlignedRef = -1;
  for (const op of alignment.cigar) {
    if (op.code === "M" || op.code === "X") {
      const code = op.code === "M" ? 1 : 2;
      for (let k = 0; k < op.length; k++) {
        if (refPos >= referenceLength || readPos >= readLength) {
          throw new Error("Alignment CIGAR exceeds sequence bounds.");
        }
        workspace.refToRead[refPos] = readPos;
        workspace.opAtRef[refPos] = code;
        if (refPos < firstAlignedRef) firstAlignedRef = refPos;
        lastAlignedRef = refPos;
        refPos++;
        readPos++;
      }
    } else if (op.code === "I") {
      workspace.insertionBefore[refPos] += op.length;
      readPos += op.length;
    } else {
      for (let k = 0; k < op.length; k++, refPos++) {
        if (refPos >= referenceLength) throw new Error("Alignment CIGAR exceeds reference bounds.");
        workspace.opAtRef[refPos] = 3;
      }
    }
  }
  if (refPos !== referenceLength) {
    throw new Error(`CIGAR consumed ${refPos} reference bases; expected ${referenceLength}.`);
  }
  return {
    refToRead: workspace.refToRead,
    opAtRef: workspace.opAtRef,
    insertionBefore: workspace.insertionBefore,
    firstAlignedRef,
    lastAlignedRef,
  };
}

/** Call configured target intervals from a single full-reference alignment. */
export function callTargetSites(
  reference: Uint8Array,
  read: Uint8Array,
  qual: Uint8Array,
  alignment: TargetedAlignment,
  sites: ReadonlyArray<ResolvedTargetSite>,
  settings: TargetSiteCallSettings,
  projection?: TargetedReadProjection,
): TargetSiteCall[] {
  if (reference.length === 0) throw new Error("Reference is empty.");
  const mapped = projection ?? buildTargetedReadProjection(reference.length, read.length, alignment);

  return sites.map((site) => {
    if (site.start0 < mapped.firstAlignedRef || site.end0 - 1 > mapped.lastAlignedRef) {
      return emptyCall(site, "not_covered");
    }
    for (let boundary = site.start0; boundary < site.end0 - 1; boundary++) {
      if (mapped.insertionBefore[boundary + 1]! > 0) return emptyCall(site, "target_insertion");
    }

    const positions: number[] = [];
    for (let p = site.start0; p < site.end0; p++) {
      const readPosition = mapped.refToRead[p]!;
      if (readPosition < 0) return emptyCall(site, "target_deletion");
      positions.push(readPosition);
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
