// Port of 01_scripts/app.py:run_preview. Pure: takes the reference sequence,
// the user's primer/round definitions, and an estimated read length;
// returns one PreviewResult per round describing where its CDS can live.
// The UI renders the raw visible sequence with per-base CDS highlighting.

import { reverseComplement } from "@cdna/core";

export type PreviewStatus = "ok-full" | "ok-truncated" | "fw-missing" | "rv-missing";

export interface PreviewInputRound {
  id: string;
  name: string;
  fwPrimer: string;
  rvPrimer: string;
}

export interface PreviewResult {
  roundId: string;
  status: PreviewStatus;
  /** Raw uppercase ACGTN of the region between Fw anchor end and either Rv
   *  anchor or read-capacity cap. Position 1 in this string corresponds to
   *  CDS coordinate 1; the UI renders it with per-base spans for CDS highlight. */
  visibleSeq: string;
  /** Distance in reference bp from the Fw anchor end to the Rv anchor start. */
  distanceToRv: number | null;
  readCapacity: number;
  message: string;
}

const ANCHOR_LEN = 10;

export function runPreview(
  reference: string,
  rounds: ReadonlyArray<PreviewInputRound>,
  estimatedReadLength: number,
): PreviewResult[] {
  const refUpper = reference.toUpperCase();
  const out: PreviewResult[] = [];

  for (const r of rounds) {
    const fw = r.fwPrimer.toUpperCase();
    const rv = r.rvPrimer.toUpperCase();
    if (!fw || !rv) continue;

    // Find left anchor: the 3'-end (last 10 bp) of the Fw primer.
    const fwAnchor = fw.length >= ANCHOR_LEN ? fw.slice(-ANCHOR_LEN) : fw;
    const matchFw = refUpper.indexOf(fwAnchor);
    if (matchFw === -1) {
      out.push({
        roundId: r.id,
        status: "fw-missing",
        visibleSeq: "",
        distanceToRv: null,
        readCapacity: estimatedReadLength - fw.length,
        message: `Fw primer 3'-end (${fwAnchor}) not found in reference.`,
      });
      continue;
    }
    const startPos = matchFw + fwAnchor.length;

    // Find right anchor: first 10 bp of reverse-complement(Rv).
    const rcRvFull = reverseComplement(rv);
    const rcRvAnchor = rcRvFull.length >= ANCHOR_LEN ? rcRvFull.slice(0, ANCHOR_LEN) : rcRvFull;
    const matchRv = refUpper.indexOf(rcRvAnchor, startPos);
    if (matchRv === -1) {
      out.push({
        roundId: r.id,
        status: "rv-missing",
        visibleSeq: "",
        distanceToRv: null,
        readCapacity: estimatedReadLength - fw.length,
        message: `Rv anchor (${rcRvAnchor}) not found in reference after Fw anchor.`,
      });
      continue;
    }

    const distToRv = matchRv - startPos;
    const readCapacity = estimatedReadLength - fw.length;
    const fullReadThrough = distToRv <= readCapacity;
    const visibleEnd = fullReadThrough ? matchRv : startPos + readCapacity;
    out.push({
      roundId: r.id,
      status: fullReadThrough ? "ok-full" : "ok-truncated",
      visibleSeq: refUpper.slice(startPos, visibleEnd),
      distanceToRv: distToRv,
      readCapacity,
      message: fullReadThrough
        ? `Read covers the full region (${distToRv} bp ≤ ${readCapacity} bp capacity).`
        : `Read is truncated: ${distToRv} bp distance exceeds ${readCapacity} bp capacity.`,
    });
  }

  return out;
}

/** Sample read length from the first 4 lines of a FASTQ file's bytes. */
export async function estimateReadLength(files: File[]): Promise<number> {
  if (files.length === 0) return 150;
  const first = files[0]!;
  const head = await first.slice(0, 4096).text();
  const lines = head.split(/\r?\n/);
  // Line 1 is the header, line 2 the sequence.
  const seq = lines[1] ?? "";
  return seq.length > 0 ? seq.length : 150;
}
