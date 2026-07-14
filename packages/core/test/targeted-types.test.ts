import { describe, expect, it } from "vitest";
import { isAllowedTargetDna, resolveTargetSites } from "../src/targeted-types.js";

describe("targeted site configuration", () => {
  const reference = "ATGGCTTGGAAACCCGGG";

  it("resolves one-based sites, WT codons and amino acids", () => {
    const out = resolveTargetSites(reference, [
      { name: "site_2", ntStart: 7, design: "NNK" },
      { name: "site_1", ntStart: 4, allowedDna: ["GCT", "TGG"] },
    ]);
    expect(out.sites.map((s) => s.name)).toEqual(["site_1", "site_2"]);
    expect(out.sites[0]!.wtDna).toBe("GCT");
    expect(out.sites[0]!.wtAa).toBe("A");
    expect(out.sites[1]!.wtDna).toBe("TGG");
    expect(out.sites[1]!.wtAa).toBe("W");
  });

  it("validates NNK/NNS and explicit allowed DNA", () => {
    const nnk = resolveTargetSites(reference, [{ name: "x", ntStart: 4, design: "NNK" }]).sites[0]!;
    expect(isAllowedTargetDna(nnk, "AAG")).toBe(true);
    expect(isAllowedTargetDna(nnk, "AAT")).toBe(true);
    expect(isAllowedTargetDna(nnk, "AAC")).toBe(false);

    const explicit = resolveTargetSites(reference, [
      { name: "x", ntStart: 4, allowedDna: ["GCT", "TGG"] },
    ]).sites[0]!;
    expect(isAllowedTargetDna(explicit, "TGG")).toBe(true);
    expect(isAllowedTargetDna(explicit, "TTT")).toBe(false);
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

