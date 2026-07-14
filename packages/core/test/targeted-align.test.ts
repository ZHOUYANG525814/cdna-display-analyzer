import { describe, expect, it } from "vitest";
import {
  alignTargetedReferenceAscii,
  estimateReferenceOffset,
} from "../src/targeted-align.js";
import { projectTargetedEvents } from "../src/targeted-events.js";

const ENC = new TextEncoder();

describe("targeted full-reference alignment", () => {
  it("aligns through free primer/adapter flanks and projects a substitution", () => {
    const ref = "ACGTCAGTACGA";
    const read = "TTTTACGTCAGTTCGAGGG";
    const aln = alignTargetedReferenceAscii(ref, read, { seedK: 5, initialBand: 4, maxBand: 32 });
    expect(aln.readStart).toBe(4);
    expect(aln.readEnd).toBe(16);
    expect(aln.matches).toBe(11);
    expect(aln.mismatches).toBe(1);
    expect(aln.insertedBases).toBe(0);
    expect(aln.deletedBases).toBe(0);
    const events = projectTargetedEvents(ENC.encode(ref), ENC.encode(read), aln);
    expect(events).toEqual([{
      type: "substitution",
      refPos0: 8,
      readPos0: 12,
      refBase: "A",
      altBase: "T",
    }]);
  });

  it("projects an insertion and deletion in reference coordinates", () => {
    const ref = "ACGTCAGTACGA";
    const insertedRead = "GGACGTCAAGTACGATT"; // insert A after reference position 5 (0-based)
    const insAln = alignTargetedReferenceAscii(ref, insertedRead, { seedK: 5, initialBand: 4, maxBand: 32 });
    expect(insAln.insertedBases).toBe(1);
    const insEvents = projectTargetedEvents(ENC.encode(ref), ENC.encode(insertedRead), insAln);
    expect(insEvents.some((e) => e.type === "insertion" && e.sequence === "A")).toBe(true);

    const deletedRead = "GGACGTCAGACGATT"; // delete reference T at position 7
    const delAln = alignTargetedReferenceAscii(ref, deletedRead, { seedK: 5, initialBand: 4, maxBand: 32 });
    expect(delAln.deletedBases).toBe(1);
    const delEvents = projectTargetedEvents(ENC.encode(ref), ENC.encode(deletedRead), delAln);
    expect(delEvents.some((e) => e.type === "deletion" && e.sequence === "T")).toBe(true);
  });

  it("uses unique k-mer seeds to estimate the amplicon offset", () => {
    const ref = ENC.encode("ACGTCAGTACGATTCG");
    const read = ENC.encode("GGGGGGACGTCAGTACGATTCGTT");
    const estimate = estimateReferenceOffset(ref, read, 7);
    expect(estimate.offset).toBe(6);
    expect(estimate.hits).toBeGreaterThan(0);
  });

  it("widens the band when traceback reaches the initial edge", () => {
    const ref = "ACGTCAGTACGATTCGATGCTAGCATCG";
    const read = "AAA" + ref.slice(0, 10) + "GGGGGG" + ref.slice(10) + "TTT";
    const aln = alignTargetedReferenceAscii(ref, read, { seedK: 7, initialBand: 2, maxBand: 16 });
    expect(aln.insertedBases).toBe(6);
    expect(aln.bandUsed).toBeGreaterThan(2);
    expect(aln.referenceCoverage).toBe(1);
  });
});

