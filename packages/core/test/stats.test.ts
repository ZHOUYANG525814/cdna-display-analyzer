import { describe, it, expect } from "vitest";
import {
  benjaminiHochberg,
  log2RpmRatio,
  log2RpmWtRatio,
  median,
  negLog10P,
  normalCdf,
  seLog2Ratio,
  seLog2RpmWtRatio,
  seLog2WtRatio,
  varLog2RpmRatio,
  twoSidedPvalue,
} from "../src/stats.js";

describe("RPM+p enrichment score", () => {
  it.each([0.5, 1])("uses pseudocount %s in RPM units", (pseudo) => {
    const score = log2RpmRatio(10, 100, 2, 80, pseudo);
    const expected =
      Math.log2((100_000 + pseudo) / (25_000 + pseudo));
    expect(score).toBeCloseTo(expected, 14);

    const qDest = pseudo * 100 / 1e6;
    const qSrc = pseudo * 80 / 1e6;
    const variance = varLog2RpmRatio(10, 100, 2, 80, pseudo);
    const expectedVariance = (1 / Math.LN2) ** 2 *
      (1 / (10 + qDest) + 1 / (100 + qDest) + 1 / (2 + qSrc) + 1 / (80 + qSrc));
    expect(variance).toBeCloseTo(expectedVariance, 14);
  });

  it("is invariant to library depth when RPM is unchanged", () => {
    expect(log2RpmRatio(10, 100, 20, 200, 0.5)).toBe(0);
  });

  it("rejects missing, zero and non-finite pseudocounts", () => {
    expect(() => log2RpmRatio(1, 10, 1, 10, undefined as unknown as number)).toThrow();
    expect(() => log2RpmRatio(1, 10, 1, 10, 0)).toThrow();
    expect(() => log2RpmRatio(1, 10, 1, 10, Number.NaN)).toThrow();
  });

  it("uses the same RPM pseudocount for legacy variant/reference ratios", () => {
    const score = log2RpmWtRatio(10, 100, 1_000, 2, 80, 800, 0.5);
    const expected = Math.log2(
      ((10_000 + 0.5) / (100_000 + 0.5)) /
      ((2_500 + 0.5) / (100_000 + 0.5)),
    );
    expect(score).toBeCloseTo(expected, 14);

    const se = seLog2RpmWtRatio(10, 100, 1_000, 2, 80, 800, 0.5);
    const q = 0.5 * 1_000 / 1e6;
    const q0 = 0.5 * 800 / 1e6;
    const expectedVariance = (1 / Math.LN2) ** 2 *
      (1 / (10 + q) + 1 / (100 + q) + 1 / (2 + q0) + 1 / (80 + q0));
    expect(se * se).toBeCloseTo(expectedVariance, 14);
  });
});

describe("normalCdf", () => {
  it("Φ(0) == 0.5 within tight tolerance", () => {
    expect(normalCdf(0)).toBeCloseTo(0.5, 6);
  });

  it("matches reference values for standard percentiles", () => {
    // From z-tables: Φ(1.96) ≈ 0.975, Φ(2.576) ≈ 0.995
    expect(normalCdf(1.96)).toBeCloseTo(0.975, 4);
    expect(normalCdf(2.576)).toBeCloseTo(0.995, 4);
    expect(normalCdf(-1.96)).toBeCloseTo(0.025, 4);
  });

  it("symmetry: Φ(z) + Φ(-z) == 1", () => {
    for (const z of [0.3, 1.2, 2.5, 3.9]) {
      expect(normalCdf(z) + normalCdf(-z)).toBeCloseTo(1, 6);
    }
  });

  it("clamps extremes to avoid 0 / 1 underflow", () => {
    expect(normalCdf(100)).toBeLessThan(1);
    expect(normalCdf(-100)).toBeGreaterThan(0);
  });
});

describe("twoSidedPvalue", () => {
  it("z=0 → p=1", () => {
    expect(twoSidedPvalue(0)).toBeCloseTo(1, 6);
  });
  it("|z|=1.96 → p ≈ 0.05 (standard threshold)", () => {
    expect(twoSidedPvalue(1.96)).toBeCloseTo(0.05, 3);
    expect(twoSidedPvalue(-1.96)).toBeCloseTo(0.05, 3);
  });
  it("|z|=2.576 → p ≈ 0.01", () => {
    expect(twoSidedPvalue(2.576)).toBeCloseTo(0.01, 3);
  });
});

describe("negLog10P", () => {
  it("p=0.05 → -log10 ≈ 1.301", () => {
    expect(negLog10P(0.05)).toBeCloseTo(1.301, 3);
  });
  it("p=1 → 0", () => {
    expect(negLog10P(1)).toBe(0);
  });
  it("p=0 returns finite ceiling (no Infinity in CSV)", () => {
    expect(negLog10P(0)).toBe(300);
    expect(Number.isFinite(negLog10P(0))).toBe(true);
  });
});

describe("seLog2Ratio", () => {
  it("equal counts ⇒ identical 1/(c+p) terms inside the sqrt", () => {
    // c1 = c2 = 9, p = 1 → SE = (1/ln2) · √(1/10 + 1/10) = (1/ln2) · √0.2
    const se = seLog2Ratio(9, 9, 1);
    const expected = Math.sqrt(0.2) / Math.LN2;
    expect(se).toBeCloseTo(expected, 9);
  });
  it("monotonically decreases as counts grow", () => {
    const lo = seLog2Ratio(5, 5, 0.5);
    const hi = seLog2Ratio(500, 500, 0.5);
    expect(hi).toBeLessThan(lo);
  });
});

describe("seLog2WtRatio", () => {
  it("four-term variance matches expanded form", () => {
    // c_v=10, wt=100, c_v0=20, wt0=200, p=1
    // SE² · (ln2)² = 1/11 + 1/101 + 1/21 + 1/201
    const se = seLog2WtRatio(10, 100, 20, 200, 1);
    const want = Math.sqrt(1 / 11 + 1 / 101 + 1 / 21 + 1 / 201) / Math.LN2;
    expect(se).toBeCloseTo(want, 9);
  });
});

describe("median", () => {
  it("odd length", () => {
    expect(median([3, 1, 2])).toBe(2);
  });
  it("even length: average of middle two", () => {
    expect(median([1, 2, 3, 4])).toBeCloseTo(2.5, 6);
  });
  it("filters non-finite", () => {
    expect(median([NaN, 1, 2, Infinity, 3])).toBe(2);
  });
  it("empty input returns 0", () => {
    expect(median([])).toBe(0);
  });
});

describe("benjaminiHochberg", () => {
  it("preserves order: q_i ≥ p_i", () => {
    const ps = [0.001, 0.04, 0.03, 0.08, 0.5];
    const qs = benjaminiHochberg(ps);
    for (let i = 0; i < ps.length; i++) {
      expect(qs[i]!).toBeGreaterThanOrEqual(ps[i]!);
    }
  });

  it("monotonicity after sorting by raw p", () => {
    // After sorting by p ascending, q values must be monotone non-decreasing.
    const ps = [0.01, 0.02, 0.03, 0.04, 0.05, 0.1, 0.2, 0.5, 0.9];
    const qs = benjaminiHochberg(ps);
    const sorted = ps.map((p, i) => ({ p, q: qs[i]! })).sort((a, b) => a.p - b.p);
    for (let i = 1; i < sorted.length; i++) {
      expect(sorted[i]!.q).toBeGreaterThanOrEqual(sorted[i - 1]!.q);
    }
  });

  it("textbook example: p=[0.01, 0.02, 0.04, 0.05] m=4 → q=[0.04, 0.04, 0.05333, 0.05]", () => {
    // BH: q_(i) = min over k≥i of (p_(k) · m / k), capped at 1.
    // i=1 p=0.01 → 0.01*4/1 = 0.04
    // i=2 p=0.02 → 0.02*4/2 = 0.04
    // i=3 p=0.04 → 0.04*4/3 ≈ 0.0533
    // i=4 p=0.05 → 0.05*4/4 = 0.05
    // After monotonicity from end: q4=0.05, q3=min(0.0533,0.05)=0.05, q2=min(0.04,0.05)=0.04, q1=0.04
    const qs = benjaminiHochberg([0.01, 0.02, 0.04, 0.05]);
    expect(qs[0]!).toBeCloseTo(0.04, 6);
    expect(qs[1]!).toBeCloseTo(0.04, 6);
    expect(qs[2]!).toBeCloseTo(0.05, 6);
    expect(qs[3]!).toBeCloseTo(0.05, 6);
  });

  it("p=1 stays at q=1", () => {
    const qs = benjaminiHochberg([1, 1, 1]);
    for (const q of qs) expect(q).toBe(1);
  });

  it("non-finite p values get NaN q", () => {
    const qs = benjaminiHochberg([NaN, 0.5, NaN]);
    expect(Number.isNaN(qs[0]!)).toBe(true);
    expect(Number.isFinite(qs[1]!)).toBe(true);
    expect(Number.isNaN(qs[2]!)).toBe(true);
  });
});
