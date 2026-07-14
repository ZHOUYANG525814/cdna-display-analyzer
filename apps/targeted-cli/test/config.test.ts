import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { loadTargetedConfig } from "../src/config.js";

const fixture = fileURLToPath(new URL("./fixtures/design.yaml", import.meta.url));
const crispressoFixture = fileURLToPath(new URL("./fixtures/crispresso-design.yaml", import.meta.url));

describe("targeted local configuration", () => {
  it("resolves reference, sites, rounds, and QC deterministically", async () => {
    const config = await loadTargetedConfig(fixture);
    expect(config.reference).toBe("ACGTCAGCTAAATGGCCGTA");
    expect(config.sites.map((site) => [site.name, site.wtDna])).toEqual([
      ["site_A", "GCT"],
      ["site_B", "TGG"],
    ]);
    expect(config.rounds[0]?.fastq).toMatch(/fixtures\/reads\.fastq$/);
    expect(config.qc).toEqual({
      minReadQ: 12,
      minAlignmentIdentity: 0.9,
      minReferenceCoverage: 0.95,
      minProtectedIdentity: 0.97,
      maxProtectedIndelBases: 0,
    });
  });

  it("reads CRISPResso2's serialized argparse Namespace", async () => {
    const config = await loadTargetedConfig(crispressoFixture);
    expect(config.reference).toBe("ACGTCAGCTAAATGGCCGTA");
    expect(config.sites[0]?.wtDna).toBe("GCT");
  });
});
