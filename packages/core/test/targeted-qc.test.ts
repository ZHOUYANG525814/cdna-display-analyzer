import { describe, expect, it } from "vitest";
import {
  alignTargetedReferenceAscii,
  buildProtectedMask,
  evaluateTargetedQc,
  resolveTargetSites,
} from "../src/index.js";

const reference = "AAACCCGGGTTT";
const sites = resolveTargetSites(reference, [{ name: "target", ntStart: 4 }]).sites;
const mask = buildProtectedMask(reference.length, sites);
const settings = {
  minReadQ: 10,
  minReferenceCoverage: 0.95,
  // The global threshold is deliberately looser than protected identity: its
  // role is gross alignment QC, not rejection of designed target changes.
  minAlignmentIdentity: 0.7,
  minProtectedIdentity: 0.95,
  maxProtectedIndelBases: 0,
};

describe("target-masked QC", () => {
  it("does not penalize substitutions inside the designed target", () => {
    const alignment = alignTargetedReferenceAscii(reference, "AAATTTGGGTTT");
    const result = evaluateTargetedQc(alignment, mask, 15, settings);
    expect(result.passed).toBe(true);
    expect(result.protectedMismatches).toBe(0);
    expect(result.protectedIdentity).toBe(1);
  });

  it("rejects substitutions outside the target", () => {
    const alignment = alignTargetedReferenceAscii(reference, "TAACCCGGGTTT");
    const result = evaluateTargetedQc(alignment, mask, 15, settings);
    expect(result.passed).toBe(false);
    expect(result.failures).toContain("low_protected_identity");
    expect(result.protectedMismatches).toBe(1);
  });

  it("keeps protected indels in a distinct failure bucket", () => {
    const alignment = alignTargetedReferenceAscii(reference, "AAACCCGGAGTTT");
    const result = evaluateTargetedQc(alignment, mask, 15, settings);
    expect(result.failures).toContain("protected_indel");
    expect(result.protectedInsertedBases).toBe(1);
  });

  it("reports read-Q failure independently", () => {
    const alignment = alignTargetedReferenceAscii(reference, reference);
    const result = evaluateTargetedQc(alignment, mask, 9.9, settings);
    expect(result.failures).toEqual(["low_read_q"]);
  });
});
