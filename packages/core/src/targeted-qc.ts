import type { TargetedAlignment } from "./targeted-align.js";

export type TargetedQcFailure =
  | "low_read_q"
  | "partial_reference"
  | "low_alignment_identity"
  | "low_protected_identity"
  | "protected_indel";

export interface TargetedQcSettings {
  minReadQ: number;
  minReferenceCoverage: number;
  minAlignmentIdentity: number;
  minProtectedIdentity: number;
  maxProtectedIndelBases: number;
}

export interface TargetedQcResult {
  passed: boolean;
  failures: TargetedQcFailure[];
  readQ: number;
  referenceCoverage: number;
  alignmentIdentity: number;
  protectedMatches: number;
  protectedMismatches: number;
  protectedInsertedBases: number;
  protectedDeletedBases: number;
  protectedIdentity: number;
}

/**
 * Evaluate strict QC while masking specified target bases. Protected identity is
 * matches / (matches + mismatches + inserted + deleted) outside target sites.
 */
export function evaluateTargetedQc(
  alignment: TargetedAlignment,
  protectedMask: Uint8Array,
  readQ: number,
  settings: TargetedQcSettings,
): TargetedQcResult {
  let refPos = 0;
  let protectedMatches = 0;
  let protectedMismatches = 0;
  let protectedInsertedBases = 0;
  let protectedDeletedBases = 0;

  for (const op of alignment.cigar) {
    if (op.code === "M" || op.code === "X") {
      for (let k = 0; k < op.length; k++, refPos++) {
        if (protectedMask[refPos] !== 1) continue;
        if (op.code === "M") protectedMatches++;
        else protectedMismatches++;
      }
    } else if (op.code === "D") {
      for (let k = 0; k < op.length; k++, refPos++) {
        if (protectedMask[refPos] === 1) protectedDeletedBases++;
      }
    } else {
      // An insertion lies between refPos-1 and refPos. Count it as protected
      // only when both flanking bases are protected (or at a protected edge).
      const leftProtected = refPos === 0 || protectedMask[refPos - 1] === 1;
      const rightProtected = refPos === protectedMask.length || protectedMask[refPos] === 1;
      if (leftProtected && rightProtected) protectedInsertedBases += op.length;
    }
  }
  if (refPos !== protectedMask.length) {
    throw new Error(`QC CIGAR consumed ${refPos} reference bases; expected ${protectedMask.length}.`);
  }

  const protectedDenominator = protectedMatches + protectedMismatches
    + protectedInsertedBases + protectedDeletedBases;
  const protectedIdentity = protectedDenominator > 0
    ? protectedMatches / protectedDenominator
    : 0;
  const failures: TargetedQcFailure[] = [];
  if (readQ < settings.minReadQ) failures.push("low_read_q");
  if (alignment.referenceCoverage < settings.minReferenceCoverage) failures.push("partial_reference");
  if (alignment.identity < settings.minAlignmentIdentity) failures.push("low_alignment_identity");
  if (protectedIdentity < settings.minProtectedIdentity) failures.push("low_protected_identity");
  if (protectedInsertedBases + protectedDeletedBases > settings.maxProtectedIndelBases) {
    failures.push("protected_indel");
  }

  return {
    passed: failures.length === 0,
    failures,
    readQ,
    referenceCoverage: alignment.referenceCoverage,
    alignmentIdentity: alignment.identity,
    protectedMatches,
    protectedMismatches,
    protectedInsertedBases,
    protectedDeletedBases,
    protectedIdentity,
  };
}
