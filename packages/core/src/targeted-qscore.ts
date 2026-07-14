// Oxford Nanopore / Dorado read-Q helpers. These intentionally live beside
// the targeted pipeline instead of replacing fastq.meanPhred: the latter is
// frozen to the historical desktop cDNA pipeline's arithmetic-mean behavior.

const HEADER_DECODER = new TextDecoder("latin1");

/** Parse Dorado's `qs:f:<value>` FASTQ/SAM-style read tag. */
export function parseDoradoHeaderQ(header: Uint8Array | string): number | null {
  const text = typeof header === "string" ? header : HEADER_DECODER.decode(header);
  const match = /(?:^|\s)qs:f:([+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?)(?=\s|$)/.exec(text);
  if (!match) return null;
  const value = Number(match[1]);
  return Number.isFinite(value) ? value : null;
}

/**
 * Recalculate Dorado mean read Q from a Phred+33 quality string.
 *
 * Dorado's documented definition is NOT the arithmetic mean of base Q:
 *   1. ignore the leading 60 bases for reads longer than 60 bases;
 *   2. convert each Q to an error probability;
 *   3. average probabilities;
 *   4. convert the mean error probability back to Phred Q.
 */
export function doradoMeanQ(qual: Uint8Array): number {
  if (qual.length === 0) return 0;
  const start = qual.length > 60 ? 60 : 0;
  const n = qual.length - start;
  if (n <= 0) return 0;

  let errorSum = 0;
  for (let i = start; i < qual.length; i++) {
    const phred = Math.max(0, qual[i]! - 33);
    errorSum += 10 ** (-phred / 10);
  }
  const meanError = errorSum / n;
  return meanError > 0 ? -10 * Math.log10(meanError) : Number.POSITIVE_INFINITY;
}

export interface DoradoReadQ {
  /** Q used for filtering: header `qs:f` when present, otherwise recalculated. */
  effective: number;
  header: number | null;
  recalculated: number;
  source: "header" | "recalculated";
  /** Header minus recalculated Q; null when the header tag is absent. */
  delta: number | null;
}

export function resolveDoradoReadQ(
  header: Uint8Array | string,
  qual: Uint8Array,
): DoradoReadQ {
  const headerQ = parseDoradoHeaderQ(header);
  const recalculated = doradoMeanQ(qual);
  return {
    effective: headerQ ?? recalculated,
    header: headerQ,
    recalculated,
    source: headerQ == null ? "recalculated" : "header",
    delta: headerQ == null ? null : headerQ - recalculated,
  };
}

