import { describe, expect, it } from "vitest";
import { streamParseEnrichmentBlob } from "../src/tools/cdna-display/viz/csvParse";

describe("versioned deterministic visualization sampling", () => {
  it("returns exactly the same reservoir for identical CSV content", async () => {
    const header = "Peptide_Seq,GC_Percent,Dominant_DNA_Seq,Count_Round_0,RPM_Round_0,Count_Round_1,RPM_Round_1,Centered_Enrich_Round_1_vs_Round_0\n";
    const rows = Array.from({ length: 31_000 }, (_, index) => `P${index},50,ATG,${index % 97},1,${index % 131},2,0`).join("\n");
    const blob = new Blob([header, rows, "\n"]);
    const first = await streamParseEnrichmentBlob(blob, { matrixLimit: 10, topLimit: 3 });
    const second = await streamParseEnrichmentBlob(blob, { matrixLimit: 10, topLimit: 3 });
    expect(second.perRoundCounts.countsByRound).toEqual(first.perRoundCounts.countsByRound);
    expect(second.matrix.rows).toEqual(first.matrix.rows);
  });
});
