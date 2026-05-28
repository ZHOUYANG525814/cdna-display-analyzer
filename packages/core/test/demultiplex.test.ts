import { describe, expect, it } from "vitest";
import {
  DemultiplexEngine,
  type DemultiplexSettings,
  indexOfBytes,
  preprocessRounds,
  reverseComplementBytesToBytes,
  type RoundConfigInput,
} from "../src/demultiplex.js";
import { bytesToAscii } from "../src/fastq.js";

const ENC = new TextEncoder();
const bytesOf = (s: string) => ENC.encode(s);

const STRICT: DemultiplexSettings = {
  adaptive: true,
  filterStop: true,
  minMeanPhred: 20.0,
  minMeanPhredCds: 20.0,
};
const NON_ADAPTIVE: DemultiplexSettings = {
  adaptive: false,
  filterStop: true,
  minMeanPhred: 20.0,
  minMeanPhredCds: 20.0,
};

// All-Q40 qual line of the requested length. 'I' = ASCII 73 = Phred+33 of 40.
// These tests aren't about Q-score filtering, so we hand the engine all-Q40
// qual so the new B2 CDS-region check never fires here.
const HI_Q = (n: number) => new Uint8Array(n).fill(0x49);

// A reusable round template: 5 bp barcode + 10 bp anchor. CDS = 9 bp (3 codons).
function mkRound(name: string, barcode: string, cdsStart = 1, cdsEnd = 9): RoundConfigInput {
  return {
    name,
    fwPrimer: barcode + "AAAAACCCCC", // anchor = AAAAACCCCC, barcode = `barcode`
    rvPrimer: "TTTTTGGGGG",            // rc = CCCCCAAAAA, rv_anchor = CCCCCAAAAA
    cdsStart,
    cdsEnd,
  };
}

describe("preprocessRounds", () => {
  it("splits a 15-bp primer into 5-bp barcode + 10-bp anchor", () => {
    const [r] = preprocessRounds([mkRound("R0", "GGGGG")]);
    expect(bytesToAscii(r!.fwBarcode)).toBe("GGGGG");
    expect(bytesToAscii(r!.fwAnchor)).toBe("AAAAACCCCC");
  });

  it("yields an empty barcode for a primer ≤10 bp", () => {
    const [r] = preprocessRounds([{
      name: "R0", fwPrimer: "ATCGATCGAT", rvPrimer: "AAAA", cdsStart: 1, cdsEnd: 3,
    }]);
    expect(r!.fwBarcode.length).toBe(0);
    expect(bytesToAscii(r!.fwAnchor)).toBe("ATCGATCGAT");
  });

  it("computes Rv anchor as RC(rv_primer)[:10]", () => {
    const [r] = preprocessRounds([mkRound("R0", "GGGGG")]);
    // rc(TTTTTGGGGG) = CCCCCAAAAA
    expect(bytesToAscii(r!.rvAnchor)).toBe("CCCCCAAAAA");
  });
});

describe("indexOfBytes", () => {
  it("finds first occurrence", () => {
    expect(indexOfBytes(bytesOf("ABCDABCD"), bytesOf("CD"))).toBe(2);
  });
  it("respects start offset", () => {
    expect(indexOfBytes(bytesOf("ABCDABCD"), bytesOf("CD"), 3)).toBe(6);
  });
  it("returns -1 when absent", () => {
    expect(indexOfBytes(bytesOf("ABC"), bytesOf("XYZ"))).toBe(-1);
  });
});

describe("reverseComplementBytesToBytes", () => {
  it("RC of ATCGN gives NCGAT", () => {
    expect(bytesToAscii(reverseComplementBytesToBytes(bytesOf("ATCGN")))).toBe("NCGAT");
  });
});

describe("DemultiplexEngine.processRead", () => {
  it("assigns and passes QC on a clean in-frame read", () => {
    // CDS spans 9 bp = 3 codons, all non-stop, no N.
    const rounds = preprocessRounds([mkRound("R0", "GGGGG", 1, 9)]);
    const e = new DemultiplexEngine(rounds, STRICT);
    // 5 bp prefix + 5 bp barcode + 10 bp anchor + 9 bp CDS + 5 bp tail
    const seq = bytesOf("NNNNN" + "GGGGG" + "AAAAACCCCC" + "ATGGCCAAA" + "TTTTT");
    expect(e.processRead(seq, HI_Q(seq.length))).toBe("assigned");

    const stats = e.stats.get("R0")!;
    expect(stats.total_assigned).toBe(1);
    expect(stats.passed_qc).toBe(1);
    expect(stats.discard_truncated).toBe(0);
    expect(stats.discard_length_indel).toBe(0);
    expect(stats.discard_stop_codon).toBe(0);

    const counter = e.dnaCounters.get("R0")!;
    expect(counter.get("ATGGCCAAA")).toBe(1);
  });

  it("flags discard_stop_codon when CDS contains TAA/TAG/TGA", () => {
    const rounds = preprocessRounds([mkRound("R0", "GGGGG", 1, 9)]);
    const e = new DemultiplexEngine(rounds, STRICT);
    // CDS = ATG TAA GCC (in-frame stop in codon 2)
    const seq = bytesOf("GGGGG" + "AAAAACCCCC" + "ATGTAAGCC" + "TTTT");
    expect(e.processRead(seq, HI_Q(seq.length))).toBe("assigned"); // assigned to round, but charged to stop bucket
    expect(e.stats.get("R0")!.discard_stop_codon).toBe(1);
    expect(e.stats.get("R0")!.passed_qc).toBe(0);
    expect(e.dnaCounters.get("R0")!.size).toBe(0);
  });

  it("flags discard_length_indel on frameshift (CDS length not divisible by 3)", () => {
    // cds_end - cds_start + 1 = 8 → length 8, not multiple of 3.
    const rounds = preprocessRounds([mkRound("R0", "GGGGG", 1, 8)]);
    const e = new DemultiplexEngine(rounds, STRICT);
    const seq = bytesOf("GGGGG" + "AAAAACCCCC" + "ATGGCCAA" + "TTTT");
    expect(e.processRead(seq, HI_Q(seq.length))).toBe("assigned");
    expect(e.stats.get("R0")!.discard_length_indel).toBe(1);
  });

  it("flags discard_truncated when the read is too short for the CDS span", () => {
    const rounds = preprocessRounds([mkRound("R0", "GGGGG", 1, 9)]);
    const e = new DemultiplexEngine(rounds, STRICT);
    // Read ends right after the anchor — no CDS at all.
    const seq = bytesOf("GGGGG" + "AAAAACCCCC");
    expect(e.processRead(seq, HI_Q(seq.length))).toBe("assigned");
    expect(e.stats.get("R0")!.discard_truncated).toBe(1);
  });

  it("returns 'no_anchor' when the Fw anchor isn't present", () => {
    const rounds = preprocessRounds([mkRound("R0", "GGGGG")]);
    const e = new DemultiplexEngine(rounds, STRICT);
    const seq = bytesOf("GTGTGTGTGTGTGTGTGT");
    expect(e.processRead(seq, HI_Q(seq.length))).toBe("no_anchor");
  });

  it("returns 'barcode_mismatch' when score exceeds MAX_BARCODE_ERROR", () => {
    const rounds = preprocessRounds([mkRound("R0", "GGGGG")]);
    const e = new DemultiplexEngine(rounds, STRICT);
    // Anchor present, but barcode is all wrong (5 mismatches → score 5 > 1.0)
    const seq = bytesOf("ATATA" + "AAAAACCCCC" + "ATGGCCAAA");
    expect(e.processRead(seq, HI_Q(seq.length))).toBe("barcode_mismatch");
  });

  it("returns 'ambiguous' when victory margin < 1.0", () => {
    // Two rounds: barcodes differ at exactly one position. Read has N at that
    // position → both score 0.5, diff = 0 → ambiguous.
    const rounds = preprocessRounds([
      mkRound("R0", "GGGAG"),
      mkRound("R1", "GGGTG"),
    ]);
    const e = new DemultiplexEngine(rounds, STRICT);
    const seq = bytesOf("GGGNG" + "AAAAACCCCC" + "ATGGCCAAA");
    expect(e.processRead(seq, HI_Q(seq.length))).toBe("ambiguous");
  });

  it("preserves stable order on tied scores (first-defined round wins)", () => {
    // Identical primers → both score 0 → diff 0 < 1.0 → ambiguous.
    // This also implicitly exercises the stable-sort property (no flapping
    // between which round 'wins' when the threshold is hit).
    const rounds = preprocessRounds([
      mkRound("FIRST", "GGGGG"),
      mkRound("SECOND", "GGGGG"),
    ]);
    const e = new DemultiplexEngine(rounds, STRICT);
    const seq = bytesOf("GGGGG" + "AAAAACCCCC" + "ATGGCCAAA");
    expect(e.processRead(seq, HI_Q(seq.length))).toBe("ambiguous");
  });

  it("adaptive=false drops a read whose Rv anchor lands inside the CDS span", () => {
    // Read layout: 5 bp barcode + 10 bp anchor + 12 bp CDS-ish + 10 bp Rv anchor + 4 bp tail.
    // CDS request 1..15 → cds_end_abs = 30, which sits past the Rv anchor at
    // position 27 but within the read (length 41). The truncation check
    // passes; the Rv anchor check fires → discard_length_indel.
    const rounds = preprocessRounds([mkRound("R0", "GGGGG", 1, 15)]);
    const e = new DemultiplexEngine(rounds, NON_ADAPTIVE);
    const seq = bytesOf("GGGGG" + "AAAAACCCCC" + "ATGGCCAAATTT" + "CCCCCAAAAA" + "TTTT");
    expect(e.processRead(seq, HI_Q(seq.length))).toBe("assigned");
    expect(e.stats.get("R0")!.discard_length_indel).toBe(1);
    expect(e.stats.get("R0")!.discard_truncated).toBe(0);
  });

  it("adaptive=true skips the Rv anchor check (read passes through)", () => {
    // Same seq + same cdsEnd as the previous test. With adaptive=true the Rv
    // check is bypassed, so the CDS bytes (15..30 = ATGGCCAAATTTCCC, M-A-K-F-P,
    // in-frame, no stop) make it through to passed_qc.
    const rounds = preprocessRounds([mkRound("R0", "GGGGG", 1, 15)]);
    const e = new DemultiplexEngine(rounds, STRICT);
    const seq = bytesOf("GGGGG" + "AAAAACCCCC" + "ATGGCCAAATTT" + "CCCCCAAAAA" + "TTTT");
    expect(e.processRead(seq, HI_Q(seq.length))).toBe("assigned");
    expect(e.stats.get("R0")!.discard_length_indel).toBe(0);
    expect(e.stats.get("R0")!.passed_qc).toBe(1);
    expect(e.dnaCounters.get("R0")!.get("ATGGCCAAATTTCCC")).toBe(1);
  });

  it("accumulates dna_counter on duplicate identical CDS slices", () => {
    const rounds = preprocessRounds([mkRound("R0", "GGGGG", 1, 9)]);
    const e = new DemultiplexEngine(rounds, STRICT);
    const seq = bytesOf("GGGGG" + "AAAAACCCCC" + "ATGGCCAAA" + "TTTT");
    e.processRead(seq, HI_Q(seq.length));
    e.processRead(seq, HI_Q(seq.length));
    e.processRead(seq, HI_Q(seq.length));
    expect(e.dnaCounters.get("R0")!.get("ATGGCCAAA")).toBe(3);
    expect(e.stats.get("R0")!.passed_qc).toBe(3);
  });
});
