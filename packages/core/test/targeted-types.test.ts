import { describe, expect, it } from "vitest";
import { resolveTargetSites } from "../src/targeted-types.js";

describe("targeted site configuration", () => {
  const reference = "ATGGCTTGGAAACCCGGG";

  it("resolves one-based sites, WT codons and amino acids", () => {
    const out = resolveTargetSites(reference, [
      { name: "site_2", ntStart: 7 },
      { name: "site_1", ntStart: 4 },
    ]);
    expect(out.sites.map((s) => s.name)).toEqual(["site_1", "site_2"]);
    expect(out.sites[0]!.wtDna).toBe("GCT");
    expect(out.sites[0]!.wtAa).toBe("A");
    expect(out.sites[1]!.wtDna).toBe("TGG");
    expect(out.sites[1]!.wtAa).toBe("W");
  });

  it("does not infer a researcher-specific codon design", () => {
    const site = resolveTargetSites(reference, [{ name: "x", ntStart: 4 }]).sites[0]!;
    expect(site).not.toHaveProperty("design");
    expect(site).not.toHaveProperty("allowedDna");
  });

  it("rejects overlaps, duplicate names and out-of-range intervals", () => {
    expect(() => resolveTargetSites(reference, [
      { name: "a", ntStart: 4 },
      { name: "b", ntStart: 6 },
    ])).toThrow(/overlap/i);
    expect(() => resolveTargetSites(reference, [
      { name: "a", ntStart: 4 },
      { name: "a", ntStart: 10 },
    ])).toThrow(/duplicate/i);
    expect(() => resolveTargetSites(reference, [{ name: "a", ntStart: 18 }])).toThrow(/exceeds/i);
  });
});
