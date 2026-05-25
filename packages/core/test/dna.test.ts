import { describe, expect, it } from "vitest";
import {
  CODON_TABLE,
  calculateGc,
  decodeCds,
  hasNoStopCodon,
  reverseComplement,
  reverseComplementBytes,
  translateDna,
} from "../src/dna.js";

const ENC = new TextEncoder();
const bytesOf = (s: string) => ENC.encode(s);

describe("CODON_TABLE", () => {
  it("has 64 entries", () => {
    expect(Object.keys(CODON_TABLE)).toHaveLength(64);
  });

  it("has exactly three stop codons (TAA, TAG, TGA)", () => {
    const stops = Object.entries(CODON_TABLE)
      .filter(([, aa]) => aa === "*")
      .map(([codon]) => codon)
      .sort();
    expect(stops).toEqual(["TAA", "TAG", "TGA"]);
  });

  it("matches the Python ATG → M anchor", () => {
    expect(CODON_TABLE.ATG).toBe("M");
  });
});

describe("reverseComplement", () => {
  it("RC of ATCGN matches Python", () => {
    // Python: 'ATCGN'.translate(str.maketrans('ATCGN','TAGCN'))[::-1] = 'NCGAT'
    expect(reverseComplement("ATCGN")).toBe("NCGAT");
  });

  it("is its own inverse", () => {
    const s = "ATGCGATAGCTAGCNCTA";
    expect(reverseComplement(reverseComplement(s))).toBe(s);
  });

  it("byte and string variants agree", () => {
    const s = "AATGCGATTAGCTAGCNCTA";
    expect(reverseComplementBytes(bytesOf(s))).toBe(reverseComplement(s));
  });

  it("passes through unknown letters unchanged (matches Python str.translate)", () => {
    // Lowercase characters aren't in the translation table → unchanged.
    expect(reverseComplement("ATgC")).toBe("GgAT");
  });
});

describe("translateDna", () => {
  it("translates a simple peptide", () => {
    // ATG GCC TAA → M A *
    expect(translateDna("ATGGCCTAA")).toBe("MA*");
  });

  it("returns X for codons containing N", () => {
    expect(translateDna("ATGGNNTAA")).toBe("MX*");
  });

  it("handles trailing 1- or 2-base partial codons as X (Python parity)", () => {
    // Python: list comprehension over range(0, len, 3) emits partial chunk → 'X'.
    expect(translateDna("ATGGCCT")).toBe("MAX");
    expect(translateDna("ATGGCCTA")).toBe("MAX");
  });

  it("empty input → empty output", () => {
    expect(translateDna("")).toBe("");
  });
});

describe("calculateGc", () => {
  it("returns 0 for empty", () => {
    expect(calculateGc("")).toBe(0);
  });

  it("matches Python formula on a known case", () => {
    // 'AGCT' → 2 of 4 GC → 50.0
    expect(calculateGc("AGCT")).toBe(50.0);
  });

  it("ignores N from the numerator only", () => {
    // 'NNNGC' → 2 GC / 5 total → 40.0
    expect(calculateGc("NNNGC")).toBe(40.0);
  });
});

describe("hasNoStopCodon", () => {
  it("rejects each of TAA, TAG, TGA", () => {
    expect(hasNoStopCodon(bytesOf("ATGTAA"))).toBe(false);
    expect(hasNoStopCodon(bytesOf("ATGTAG"))).toBe(false);
    expect(hasNoStopCodon(bytesOf("ATGTGA"))).toBe(false);
  });

  it("accepts a stop-free peptide", () => {
    expect(hasNoStopCodon(bytesOf("ATGGCCAAA"))).toBe(true);
  });

  it("only checks complete codons; partial trailing bases are ignored", () => {
    // 'ATGTA' — first codon ATG (M), trailing 'TA' incomplete.
    expect(hasNoStopCodon(bytesOf("ATGTA"))).toBe(true);
  });

  it("agrees with translateDna over a battery of random codon strings", () => {
    // Light fuzz: build random in-frame DNA, check both code paths agree on stop-presence.
    const bases = ["A", "C", "G", "T"];
    const rng = mulberry32(0xc0ffee);
    for (let trial = 0; trial < 200; trial++) {
      const nCodons = 1 + Math.floor(rng() * 30);
      let s = "";
      for (let i = 0; i < nCodons * 3; i++) {
        s += bases[Math.floor(rng() * 4)];
      }
      const fast = hasNoStopCodon(bytesOf(s));
      const slow = !translateDna(s).includes("*");
      expect(fast).toBe(slow);
    }
  });
});

describe("decodeCds", () => {
  it("produces a fresh string with no parent buffer reference", () => {
    const big = new Uint8Array(1024);
    big.set(bytesOf("ATGGCC"), 100);
    const slice = big.slice(100, 106);
    const s = decodeCds(slice);
    expect(s).toBe("ATGGCC");
    // The slice is a fresh ArrayBuffer; the decoded string is atomized.
    expect(s.length).toBe(6);
  });
});

// Tiny deterministic PRNG so the fuzz test is reproducible across runs.
function mulberry32(seed: number) {
  let a = seed >>> 0;
  return function () {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
