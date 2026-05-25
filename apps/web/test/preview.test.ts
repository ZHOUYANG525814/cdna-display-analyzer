import { describe, expect, it } from "vitest";
import { runPreview } from "../src/tools/cdna-display/preview";

describe("runPreview", () => {
  // Reference: 5 bp prefix + 10 bp Fw anchor + 30 bp CDS + 10 bp RC(Rv anchor) + 5 bp tail
  const REF =
    "NNNNN" + "AAAAACCCCC" + "AAATTTGGGCCCAAATTTGGGCCCAAATTT" + "CCCCCAAAAA" + "NNNNN";

  const ROUND = {
    id: "r0",
    name: "Round_0",
    fwPrimer: "GGGGGAAAAACCCCC",   // anchor = AAAAACCCCC (last 10)
    rvPrimer: "TTTTTGGGGG",          // rc = CCCCCAAAAA, anchor = CCCCCAAAAA (first 10)
  };

  it("emits ok-full when read capacity covers the full distance", () => {
    // Capacity = 150 (default) − 15 (fw_primer length) = 135 bp ≫ 30 bp distance.
    const [r] = runPreview(REF, [ROUND], 150);
    expect(r!.status).toBe("ok-full");
    expect(r!.distanceToRv).toBe(30);
    expect(r!.readCapacity).toBe(135);
    expect(r!.visibleSeq).toBe("AAATTTGGGCCCAAATTTGGGCCCAAATTT");
  });

  it("emits ok-truncated when distance exceeds read capacity", () => {
    // Force capacity below 30 by setting read length = 20 → capacity = 20 − 15 = 5.
    const [r] = runPreview(REF, [ROUND], 20);
    expect(r!.status).toBe("ok-truncated");
    expect(r!.distanceToRv).toBe(30);
    expect(r!.readCapacity).toBe(5);
    // Visible region is only the first 5 bp of the CDS span.
    expect(r!.visibleSeq).toBe("AAATT");
  });

  it("flags fw-missing when the Fw anchor is absent", () => {
    const [r] = runPreview("GGGGGGGGGGGGGGG", [ROUND], 150);
    expect(r!.status).toBe("fw-missing");
    expect(r!.visibleSeq).toBe("");
  });

  it("flags rv-missing when only the Fw anchor matches", () => {
    const ref = "AAAAACCCCC" + "AAATTTGGGCCC";  // Fw anchor present, Rv absent
    const [r] = runPreview(ref, [ROUND], 150);
    expect(r!.status).toBe("rv-missing");
  });

  it("skips rounds with empty primers (no error)", () => {
    const results = runPreview(REF, [{ ...ROUND, fwPrimer: "" }], 150);
    expect(results).toHaveLength(0);
  });
});
