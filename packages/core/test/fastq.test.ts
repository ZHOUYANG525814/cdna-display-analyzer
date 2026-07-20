import { describe, expect, it } from "vitest";
import {
  LineSplitter,
  bytesToAscii,
  isValidFastqRecord,
  meanPhred,
  readFastqRecords,
  readFastqRecordsResilient,
  type FastqRecord,
} from "../src/fastq.js";

const ENC = new TextEncoder();
const bytesOf = (s: string) => ENC.encode(s);

// A small but realistic FASTQ fixture: 3 well-formed records, mixed line lengths.
const SAMPLE_FASTQ =
  "@r1 desc\n" +
  "ATCGATCGATCG\n" +
  "+\n" +
  "IIIIIIIIIIII\n" +
  "@r2\n" +
  "GGGGAAAA\n" +
  "+\n" +
  "BCDEFGHI\n" +
  "@r3\n" +
  "TTTT\n" +
  "+\n" +
  "!!!!\n";

// Async iterable from a fixed list of chunks — emulates a streaming source.
async function* iter(chunks: Uint8Array[]): AsyncIterableIterator<Uint8Array> {
  for (const c of chunks) yield c;
}

async function collect<T>(it: AsyncIterable<T>): Promise<T[]> {
  const out: T[] = [];
  for await (const x of it) out.push(x);
  return out;
}

describe("LineSplitter", () => {
  it("splits a single chunk into lines (no carry)", () => {
    const sp = new LineSplitter();
    const lines = [...sp.consume(bytesOf("a\nb\nc\n"))].map(bytesToAscii);
    expect(lines).toEqual(["a", "b", "c"]);
    expect([...sp.flush()]).toEqual([]);
  });

  it("preserves a trailing partial line as carry until flush", () => {
    const sp = new LineSplitter();
    const lines = [...sp.consume(bytesOf("a\nb"))].map(bytesToAscii);
    expect(lines).toEqual(["a"]);
    const flushed = [...sp.flush()].map(bytesToAscii);
    expect(flushed).toEqual(["b"]);
  });

  it("strips trailing CR (Windows line endings)", () => {
    const sp = new LineSplitter();
    const lines = [...sp.consume(bytesOf("a\r\nb\r\n"))].map(bytesToAscii);
    expect(lines).toEqual(["a", "b"]);
  });

  it("handles an empty line as zero-length", () => {
    const sp = new LineSplitter();
    const lines = [...sp.consume(bytesOf("a\n\nb\n"))].map(bytesToAscii);
    expect(lines).toEqual(["a", "", "b"]);
  });

  it("emits nothing on empty input", () => {
    const sp = new LineSplitter();
    expect([...sp.consume(new Uint8Array(0))]).toEqual([]);
    expect([...sp.flush()]).toEqual([]);
  });
});

describe("readFastqRecordsResilient — malformed input recovery", () => {
  it("emits a bad record and resumes at the next header after a missing separator", async () => {
    const input = "@bad qs:f:20\nACGT\nnot-plus\nIIII\n@good qs:f:20\nTGCA\n+\nIIII\n";
    const records = await collect(readFastqRecordsResilient(iter([bytesOf(input)])));
    expect(records).toHaveLength(2); // one malformed record, then recovered good record
    expect(bytesToAscii(records.at(-1)!.header)).toContain("@good");
    expect(bytesToAscii(records.at(-1)!.seq)).toBe("TGCA");
  });

  it("emits a trailing partial record instead of silently dropping it", async () => {
    const records = await collect(readFastqRecordsResilient(iter([bytesOf("@partial\nACGT\n+\n")])));
    expect(records).toHaveLength(1);
    expect(records[0]!.qual).toHaveLength(0);
  });

  it("accepts a valid quality line beginning with @", async () => {
    const records = await collect(readFastqRecordsResilient(iter([bytesOf("@r\nACGT\n+\n@III\n")])));
    expect(records).toHaveLength(1);
    expect(bytesToAscii(records[0]!.qual)).toBe("@III");
  });
});

describe("isValidFastqRecord", () => {
  const record = (
    header = "@read",
    seq = "ACGTN",
    separator = "+",
    qual = "IIIII",
  ): FastqRecord => ({
    header: bytesOf(header),
    seq: bytesOf(seq),
    separator: bytesOf(separator),
    qual: bytesOf(qual),
  });

  it("accepts upper/lowercase ACGTN and printable Phred+33", () => {
    expect(isValidFastqRecord(record("@r", "aCgTn", "+r", "!I~I!"))).toBe(true);
  });

  it.each([
    record("@", "ACGT", "+", "IIII"),
    record("@ ", "ACGT", "+", "IIII"),
    record("read", "ACGT", "+", "IIII"),
    record("@r", "", "+", ""),
    record("@r", "ACGX", "+", "IIII"),
    record("@r", "ACGT", "not-plus", "IIII"),
    record("@r", "ACGT", "+", "III"),
    record("@r", "ACGT", "+", "III "),
  ])("rejects malformed record %#", (value) => {
    expect(isValidFastqRecord(value)).toBe(false);
  });
});

// The point of this test: a stream-based pipeline MUST handle a chunk boundary
// landing at any byte offset. For the small fixture above, exhaustively try
// every two-chunk split and assert the record stream is bit-identical.
describe("readFastqRecords — chunk-boundary fuzz", () => {
  it("produces identical records for every possible two-chunk split", async () => {
    const all = bytesOf(SAMPLE_FASTQ);

    // First, the reference: feed the whole buffer as one chunk.
    const reference = await collect(readFastqRecords(iter([all])));
    expect(reference).toHaveLength(3);
    expect(bytesToAscii(reference[0]!.seq)).toBe("ATCGATCGATCG");
    expect(bytesToAscii(reference[0]!.qual)).toBe("IIIIIIIIIIII");

    // Now split at every byte offset; reconstructed records must match.
    for (let cut = 0; cut <= all.length; cut++) {
      const left = all.slice(0, cut);
      const right = all.slice(cut);
      const recs = await collect(readFastqRecords(iter([left, right])));
      expect(recs).toHaveLength(reference.length);
      for (let r = 0; r < recs.length; r++) {
        const a = recs[r]!;
        const b = reference[r]!;
        expect(bytesToAscii(a.header), `cut=${cut} rec=${r} header`).toBe(bytesToAscii(b.header));
        expect(bytesToAscii(a.seq), `cut=${cut} rec=${r} seq`).toBe(bytesToAscii(b.seq));
        expect(bytesToAscii(a.qual), `cut=${cut} rec=${r} qual`).toBe(bytesToAscii(b.qual));
      }
    }
  });

  it("survives a chunk-per-byte stream", async () => {
    const all = bytesOf(SAMPLE_FASTQ);
    const oneByteChunks: Uint8Array[] = [];
    for (let i = 0; i < all.length; i++) oneByteChunks.push(all.subarray(i, i + 1));
    const recs = await collect(readFastqRecords(iter(oneByteChunks)));
    expect(recs).toHaveLength(3);
    expect(bytesToAscii(recs[2]!.seq)).toBe("TTTT");
  });

  it("drops a trailing partial record (no qual) silently", async () => {
    // A FASTQ truncated mid-record after only 3 lines: header, seq, '+'.
    const truncated = SAMPLE_FASTQ + "@r4\nAAAA\n+\n";
    const recs = await collect(readFastqRecords(iter([bytesOf(truncated)])));
    expect(recs).toHaveLength(3);
  });
});

describe("meanPhred", () => {
  it("matches Python: sum(ord(c)-33) / len for 'IIII' (I=73)", () => {
    // 'I' has Phred ASCII 73 → score 40 per base → mean 40.
    expect(meanPhred(bytesOf("IIII"))).toBe(40);
  });

  it("returns 0 on empty (safe-fail; treated as below any positive threshold)", () => {
    expect(meanPhred(new Uint8Array(0))).toBe(0);
  });

  it("threshold semantics match the Python QC filter (mean < 20.0 drops)", () => {
    // Python: discards a read when mean < 20.0. Build a qual with mean = 19.5.
    // Choose 4 chars with Phred scores 19, 19, 20, 20 → mean 19.5.
    // Phred 19 → ASCII 52 = '4'; Phred 20 → ASCII 53 = '5'.
    const qual = bytesOf("4455");
    const mean = meanPhred(qual);
    expect(mean).toBeLessThan(20.0);
    expect(mean).toBe(19.5);
  });
});

describe("FastqRecord ownership", () => {
  it("decoding seq into a string after the chunk goes out of scope still works", async () => {
    // Verifies our carry-buffer copy semantics: lines emitted from the splitter
    // must not pin the upstream chunk in a way that breaks when re-read.
    const all = bytesOf(SAMPLE_FASTQ);
    const recs: FastqRecord[] = [];
    for await (const r of readFastqRecords(iter([all.slice(0, 5), all.slice(5)]))) {
      // Copy the seq line out — analogous to what the demultiplex stage does.
      const copied = r.seq.slice();
      recs.push({ header: r.header.slice(), seq: copied, separator: r.separator.slice(), qual: r.qual.slice() });
    }
    expect(bytesToAscii(recs[0]!.seq)).toBe("ATCGATCGATCG");
  });
});
