import { describe, expect, it } from "vitest";
import { alignTargetedReferenceAscii } from "../src/targeted-align.js";
import { buildProtectedMask, buildTargetHaplotype, callTargetSites } from "../src/targeted-caller.js";
import { resolveTargetSites } from "../src/targeted-types.js";

const ENC = new TextEncoder();

describe("targeted multi-site caller", () => {
  const reference = "ACGTCAGCTAAATGGCCGTA";
  const sites = resolveTargetSites(reference, [
    { name: "site_A", ntStart: 7 },
    { name: "site_B", ntStart: 13 },
  ]).sites;

  it("calls WT and allowed variants from one full alignment", () => {
    const read = "TT" + "ACGTCATGGAAATGGCCGTA" + "GG";
    const aln = alignTargetedReferenceAscii(reference, read, { seedK: 5, initialBand: 4, maxBand: 32 });
    const calls = callTargetSites(ENC.encode(reference), ENC.encode(read), ENC.encode("I".repeat(read.length)), aln, sites, { minBaseQ: 15 });
    expect(calls.map((c) => [c.siteName, c.status, c.observedDna])).toEqual([
      ["site_A", "variant", "TGG"],
      ["site_B", "wt", "TGG"],
    ]);
    expect(buildTargetHaplotype(calls)).toBe("TGG|TGG");
  });

  it("keeps any complete high-quality codon callable without a design assumption", () => {
    const read = "ACGTCAACCAAATGGCCGTA";
    const aln = alignTargetedReferenceAscii(reference, read, { seedK: 5, initialBand: 4, maxBand: 32 });
    const calls = callTargetSites(ENC.encode(reference), ENC.encode(read), ENC.encode("I".repeat(read.length)), aln, sites, { minBaseQ: 15 });
    expect(calls[0]!.status).toBe("variant");
    expect(calls[0]!.codonCallable).toBe(true);
  });

  it("keeps a stop codon in enrichment with an explicit stop flag", () => {
    const stopSites = resolveTargetSites(reference, [{ name: "site_B", ntStart: 13 }]).sites;
    const read = reference.slice(0, 12) + "TAG" + reference.slice(15);
    const aln = alignTargetedReferenceAscii(reference, read, { seedK: 5, initialBand: 4, maxBand: 32 });
    const [call] = callTargetSites(ENC.encode(reference), ENC.encode(read), ENC.encode("I".repeat(read.length)), aln, stopSites, { minBaseQ: 15 });
    expect(call?.status).toBe("stop_codon");
    expect(call?.observedAa).toBe("*");
    expect(call?.codonCallable).toBe(true);
  });

  it("does not let one low-Q site erase another callable site", () => {
    const read = reference;
    const q = "!".repeat(9) + "I".repeat(read.length - 9);
    const aln = alignTargetedReferenceAscii(reference, read, { seedK: 5, initialBand: 4, maxBand: 32 });
    const calls = callTargetSites(ENC.encode(reference), ENC.encode(read), ENC.encode(q), aln, sites, { minBaseQ: 15 });
    expect(calls[0]!.status).toBe("low_quality");
    expect(calls[1]!.status).toBe("wt");
    expect(buildTargetHaplotype(calls)).toBeNull();
  });

  it("builds a target-excluded protected mask", () => {
    const mask = buildProtectedMask(reference.length, sites);
    expect([...mask.slice(6, 9)]).toEqual([0, 0, 0]);
    expect([...mask.slice(12, 15)]).toEqual([0, 0, 0]);
    expect(mask.reduce((a, b) => a + b, 0)).toBe(reference.length - 6);
  });
});
