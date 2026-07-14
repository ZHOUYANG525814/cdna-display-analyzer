import { normalizeReference, translateDna } from "@cdna/core";

export interface AminoAcidTargetLabel { name: string; aaPosition: number; referenceAa: string; wtDna: string; }

/** Convert a confirmed 1-based amplicon codon coordinate to a biological
 * target label such as R233. The reference is already required to be pasted
 * in coding orientation by the UI. */
export function aminoAcidTargetLabel(referenceInput: string, cdsStart1: number, ntStart1: number): AminoAcidTargetLabel {
  const reference = normalizeReference(referenceInput);
  const delta = ntStart1 - cdsStart1;
  if (!Number.isInteger(cdsStart1) || !Number.isInteger(ntStart1) || delta < 0 || delta % 3 !== 0 || ntStart1 + 1 >= reference.length) {
    throw new Error(`Target nt ${ntStart1} is not a complete CDS codon.`);
  }
  const aaPosition = delta / 3 + 1;
  const wtDna = reference.slice(ntStart1 - 1, ntStart1 + 2);
  const referenceAa = translateDna(wtDna);
  return { name: `${referenceAa}${aaPosition}`, aaPosition, referenceAa, wtDna };
}
