// Reference-to-read alignment for targeted multi-site amplicons.
//
// This is the correctness-first TypeScript implementation. It estimates the
// reference diagonal from exact unique k-mer seeds, then performs a banded
// affine-gap semi-global alignment: the complete reference is aligned while
// read prefix/suffix (primers/adapters) are free. If traceback approaches the
// band edge the caller retries with a wider band. The same API is intended to
// become the parity oracle for a selective WASM hot-path port.

export type CigarCode = "M" | "X" | "I" | "D";

export interface CigarOp {
  code: CigarCode;
  length: number;
}

export interface TargetedAlignOptions {
  matchScore?: number;
  mismatchScore?: number;
  gapOpenScore?: number;
  gapExtendScore?: number;
  seedK?: number;
  initialBand?: number;
  maxBand?: number;
}

export interface TargetedAlignment {
  score: number;
  readStart: number;
  readEnd: number;
  matches: number;
  mismatches: number;
  insertedBases: number;
  deletedBases: number;
  identity: number;
  referenceCoverage: number;
  cigar: CigarOp[];
  cigarString: string;
  estimatedOffset: number;
  seedHits: number;
  bandUsed: number;
  bandTouched: boolean;
}

const NEG = -0x3fffffff;
const STATE_M = 0;
const STATE_I = 1; // insertion in read relative to reference
const STATE_D = 2; // deletion in read relative to reference
const TRACE_NONE = 255;

const DEFAULTS = Object.freeze({
  matchScore: 2,
  mismatchScore: -3,
  gapOpenScore: -5,
  gapExtendScore: -1,
  seedK: 11,
  initialBand: 24,
  maxBand: 192,
});

export interface TargetedDiagonalEstimate {
  offset: number;
  hits: number;
}

/** Immutable reference-side k-mer index. Build once per run and reuse for
 * every forward/reverse read query; the reference never changes mid-run. */
export interface TargetedReferenceSeedIndex {
  readonly referenceLength: number;
  readonly k: number;
  readonly uniqueKmers: ReadonlyMap<number, number>;
}

export function createTargetedReferenceSeedIndex(
  reference: Uint8Array,
  k: number = DEFAULTS.seedK,
): TargetedReferenceSeedIndex {
  const refKmers = new Map<number, number>();
  if (k >= 3 && k <= 15 && reference.length >= k) {
    for (let i = 0; i + k <= reference.length; i++) {
      const key = encodeKmer(reference, i, k);
      if (key < 0) continue;
      refKmers.set(key, refKmers.has(key) ? -1 : i);
    }
  }
  return { referenceLength: reference.length, k, uniqueKmers: refKmers };
}

export function estimateReferenceOffsetIndexed(
  index: TargetedReferenceSeedIndex,
  read: Uint8Array,
): TargetedDiagonalEstimate {
  const { k, referenceLength } = index;
  if (k < 3 || k > 15 || referenceLength < k || read.length < k) {
    return { offset: Math.max(0, Math.floor((read.length - referenceLength) / 2)), hits: 0 };
  }
  const offsets: number[] = [];
  for (let j = 0; j + k <= read.length; j++) {
    const key = encodeKmer(read, j, k);
    if (key < 0) continue;
    const refPos = index.uniqueKmers.get(key);
    if (refPos != null && refPos >= 0) offsets.push(j - refPos);
  }
  if (offsets.length === 0) {
    return { offset: Math.max(0, Math.floor((read.length - referenceLength) / 2)), hits: 0 };
  }
  offsets.sort((a, b) => a - b);
  return { offset: offsets[Math.floor(offsets.length / 2)]!, hits: offsets.length };
}

/** Estimate readPos-referencePos from exact k-mers unique in the reference. */
export function estimateReferenceOffset(
  reference: Uint8Array,
  read: Uint8Array,
  k: number = DEFAULTS.seedK,
): TargetedDiagonalEstimate {
  return estimateReferenceOffsetIndexed(createTargetedReferenceSeedIndex(reference, k), read);
}

function encodeKmer(seq: Uint8Array, start: number, k: number): number {
  let value = 0;
  for (let i = 0; i < k; i++) {
    const b = seq[start + i]!;
    let code: number;
    if (b === 65 || b === 97) code = 0; // A
    else if (b === 67 || b === 99) code = 1; // C
    else if (b === 71 || b === 103) code = 2; // G
    else if (b === 84 || b === 116) code = 3; // T
    else return -1;
    value = (value << 2) | code;
  }
  return value;
}

/** Align the complete reference to the best read substring. */
export function alignTargetedReference(
  reference: Uint8Array,
  read: Uint8Array,
  options: TargetedAlignOptions = {},
): TargetedAlignment {
  if (reference.length === 0) throw new Error("Cannot align an empty reference.");
  if (read.length === 0) throw new Error("Cannot align an empty read.");

  const cfg = { ...DEFAULTS, ...options };
  if (cfg.initialBand < 1 || cfg.maxBand < cfg.initialBand) {
    throw new Error("Alignment band settings are invalid.");
  }
  const estimate = estimateReferenceOffset(reference, read, cfg.seedK);
  return alignTargetedReferenceWithEstimate(reference, read, estimate, options);
}

/** Alignment entry point for callers that already queried a run-scoped seed
 * index. It is mathematically identical to alignTargetedReference and avoids
 * rebuilding/re-querying the same reference index for the chosen strand. */
export function alignTargetedReferenceWithEstimate(
  reference: Uint8Array,
  read: Uint8Array,
  estimate: TargetedDiagonalEstimate,
  options: TargetedAlignOptions = {},
): TargetedAlignment {
  if (reference.length === 0) throw new Error("Cannot align an empty reference.");
  if (read.length === 0) throw new Error("Cannot align an empty read.");
  const cfg = { ...DEFAULTS, ...options };
  if (cfg.initialBand < 1 || cfg.maxBand < cfg.initialBand) {
    throw new Error("Alignment band settings are invalid.");
  }
  let band = cfg.initialBand;
  let result: TargetedAlignment | null;
  while (true) {
    result = alignAtBand(reference, read, estimate, band, cfg);
    if (result == null) {
      if (band >= cfg.maxBand) throw new Error(`No alignment path found within maximum band ${band}.`);
      band = Math.min(cfg.maxBand, band * 2);
      continue;
    }
    // A too-narrow band can produce a locally valid traceback that avoids the
    // edge by converting a real insertion into terminal deletions/mismatches.
    // Low reference coverage is therefore also a widening signal.
    if ((!result.bandTouched && result.referenceCoverage >= 0.98) || band >= cfg.maxBand) return result;
    band = Math.min(cfg.maxBand, band * 2);
  }
}

function alignAtBand(
  reference: Uint8Array,
  read: Uint8Array,
  estimate: TargetedDiagonalEstimate,
  band: number,
  cfg: Required<TargetedAlignOptions>,
): TargetedAlignment | null {
  const m = reference.length;
  // Restrict the DP to the estimated amplicon plus band-sized flanks. Prefix
  // and suffix inside this window remain free through semi-global boundaries.
  const windowStart = Math.max(0, estimate.offset - band);
  const windowEnd = Math.min(read.length, estimate.offset + m + band);
  const window = read.subarray(windowStart, windowEnd);
  const n = window.length;
  const localOffset = estimate.offset - windowStart;
  const width = n + 1;

  let prevM = new Int32Array(width);
  let prevI = new Int32Array(width);
  let prevD = new Int32Array(width);
  let currM = new Int32Array(width);
  let currI = new Int32Array(width);
  let currD = new Int32Array(width);
  prevM.fill(NEG); prevI.fill(NEG); prevD.fill(NEG);

  // Free read prefix, constrained to the first row's band.
  const row0Max = Math.min(n, localOffset + band);
  for (let j = 0; j <= row0Max; j++) prevM[j] = 0;

  // One byte per state for band-visited cells only. The old rectangular
  // layout allocated ~4.5 MB for a 1.2-kb read even at band 24; this packed
  // layout stores <= (2*band+1) cells per row without changing any DP state.
  const traceWidth = (2 * band) + 1;
  const trace = new Uint8Array((m + 1) * traceWidth * 3);
  trace.fill(TRACE_NONE);
  for (let i = 1; i <= m; i++) {
    currM.fill(NEG); currI.fill(NEG); currD.fill(NEG);
    const center = i + localOffset;
    const jMin = Math.max(0, center - band);
    const jMax = Math.min(n, center + band);
    const traceRowBase = i * traceWidth * 3;
    for (let j = jMin; j <= jMax; j++) {
      if (j > 0) {
        let diagScore = prevM[j - 1]!;
        let diagState = STATE_M;
        if (prevI[j - 1]! > diagScore) { diagScore = prevI[j - 1]!; diagState = STATE_I; }
        if (prevD[j - 1]! > diagScore) { diagScore = prevD[j - 1]!; diagState = STATE_D; }
        if (diagScore > NEG / 2) {
          currM[j] = diagScore + (reference[i - 1] === window[j - 1]
            ? cfg.matchScore
            : cfg.mismatchScore);
          trace[traceRowBase + ((j - jMin) * 3) + STATE_M] = diagState;
        }

        let insScore = currM[j - 1]! + cfg.gapOpenScore;
        let insState = STATE_M;
        const extendInsertion = currI[j - 1]! + cfg.gapExtendScore;
        if (extendInsertion > insScore) { insScore = extendInsertion; insState = STATE_I; }
        const switchFromDeletion = currD[j - 1]! + cfg.gapOpenScore;
        if (switchFromDeletion > insScore) { insScore = switchFromDeletion; insState = STATE_D; }
        if (insScore > NEG / 2) {
          currI[j] = insScore;
          trace[traceRowBase + ((j - jMin) * 3) + STATE_I] = insState;
        }
      }

      let delScore = prevM[j]! + cfg.gapOpenScore;
      let delState = STATE_M;
      const switchFromInsertion = prevI[j]! + cfg.gapOpenScore;
      if (switchFromInsertion > delScore) { delScore = switchFromInsertion; delState = STATE_I; }
      const extendDeletion = prevD[j]! + cfg.gapExtendScore;
      if (extendDeletion > delScore) { delScore = extendDeletion; delState = STATE_D; }
      if (delScore > NEG / 2) {
        currD[j] = delScore;
        trace[traceRowBase + ((j - jMin) * 3) + STATE_D] = delState;
      }
    }
    [prevM, currM] = [currM, prevM];
    [prevI, currI] = [currI, prevI];
    [prevD, currD] = [currD, prevD];
  }

  // Free read suffix: best endpoint anywhere in the final row's band.
  let endJ = -1;
  let endState = STATE_M;
  let bestScore = NEG;
  const endCenter = m + localOffset;
  const endMin = Math.max(0, endCenter - band);
  const endMax = Math.min(n, endCenter + band);
  for (let j = endMin; j <= endMax; j++) {
    let score = prevM[j]!;
    let state = STATE_M;
    if (prevI[j]! > score) { score = prevI[j]!; state = STATE_I; }
    if (prevD[j]! > score) { score = prevD[j]!; state = STATE_D; }
    if (score > bestScore) {
      bestScore = score;
      endJ = j;
      endState = state;
    }
  }
  if (endJ < 0 || bestScore <= NEG / 2) {
    return null;
  }

  const reversed: CigarCode[] = [];
  let i = m;
  let j = endJ;
  let state = endState;
  let bandTouched = false;
  while (i > 0) {
    if (Math.abs((j - i) - localOffset) >= band - 1) bandTouched = true;
    const rowMin = Math.max(0, i + localOffset - band);
    const previous = trace[((i * traceWidth + (j - rowMin)) * 3) + state]!;
    if (previous === TRACE_NONE) {
      throw new Error(`Alignment traceback failed at reference=${i}, read=${j}, state=${state}.`);
    }
    if (state === STATE_M) {
      reversed.push(reference[i - 1] === window[j - 1] ? "M" : "X");
      i--; j--;
    } else if (state === STATE_I) {
      reversed.push("I");
      j--;
    } else {
      reversed.push("D");
      i--;
    }
    state = previous;
  }

  const readStart = windowStart + j;
  const readEnd = windowStart + endJ;
  reversed.reverse();
  const cigar = collapseCigar(reversed);
  let matches = 0;
  let mismatches = 0;
  let insertedBases = 0;
  let deletedBases = 0;
  for (const op of cigar) {
    if (op.code === "M") matches += op.length;
    else if (op.code === "X") mismatches += op.length;
    else if (op.code === "I") insertedBases += op.length;
    else deletedBases += op.length;
  }
  const compared = matches + mismatches + insertedBases + deletedBases;
  return {
    score: bestScore,
    readStart,
    readEnd,
    matches,
    mismatches,
    insertedBases,
    deletedBases,
    identity: compared > 0 ? matches / compared : 0,
    referenceCoverage: m > 0 ? (matches + mismatches) / m : 0,
    cigar,
    cigarString: cigar.map((op) => `${op.length}${op.code}`).join(""),
    estimatedOffset: estimate.offset,
    seedHits: estimate.hits,
    bandUsed: band,
    bandTouched,
  };
}

function collapseCigar(codes: ReadonlyArray<CigarCode>): CigarOp[] {
  const out: CigarOp[] = [];
  for (const code of codes) {
    const last = out[out.length - 1];
    if (last?.code === code) last.length++;
    else out.push({ code, length: 1 });
  }
  return out;
}

const ENC = new TextEncoder();

export function alignTargetedReferenceAscii(
  reference: string,
  read: string,
  options: TargetedAlignOptions = {},
): TargetedAlignment {
  return alignTargetedReference(ENC.encode(reference.toUpperCase()), ENC.encode(read.toUpperCase()), options);
}
