import { describe, expect, it } from "vitest";
import {
  doradoMeanQ,
  parseDoradoHeaderQ,
  resolveDoradoReadQ,
} from "../src/targeted-qscore.js";

const ENC = new TextEncoder();

describe("Dorado-compatible read Q", () => {
  it("parses qs:f from a real-style FASTQ header", () => {
    const header = ENC.encode("@read-1\tqs:f:16.832447\tmx:i:1\tdx:i:0");
    expect(parseDoradoHeaderQ(header)).toBeCloseTo(16.832447, 6);
  });

  it("returns null for absent or malformed tags", () => {
    expect(parseDoradoHeaderQ("@read-1 mx:i:1")).toBeNull();
    expect(parseDoradoHeaderQ("@read-1 qs:f:not-a-number")).toBeNull();
  });

  it("averages error probabilities rather than Phred values", () => {
    // Q10 and Q30: arithmetic Q=20, Dorado Q=-10log10((0.1+0.001)/2).
    const qual = ENC.encode("+?");
    const expected = -10 * Math.log10((0.1 + 0.001) / 2);
    expect(doradoMeanQ(qual)).toBeCloseTo(expected, 12);
    expect(doradoMeanQ(qual)).toBeLessThan(20);
  });

  it("ignores the leading 60 bases on reads longer than 60", () => {
    const qual = ENC.encode("!".repeat(60) + "I".repeat(10));
    expect(doradoMeanQ(qual)).toBeCloseTo(40, 10);
  });

  it("uses qs:f as effective Q and keeps recalculation as a diagnostic", () => {
    const resolved = resolveDoradoReadQ("@r qs:f:15.5", ENC.encode("I".repeat(70)));
    expect(resolved.effective).toBe(15.5);
    expect(resolved.source).toBe("header");
    expect(resolved.recalculated).toBeCloseTo(40, 10);
    expect(resolved.delta).toBeCloseTo(-24.5, 10);
  });
});
