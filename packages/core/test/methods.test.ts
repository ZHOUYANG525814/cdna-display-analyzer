import { describe, expect, it } from "vitest";
import { CDNA_METHODS, formatMethodsAsText, TARGETED_NANOPORE_METHODS } from "../src/methods.js";

describe("dynamic methods documentation", () => {
  it.each([0.5, 1])("records the actual pseudocount %s", (pseudocount) => {
    const text = formatMethodsAsText(CDNA_METHODS, { pseudocount });
    expect(text).toContain(`Pseudocount (RPM)                 ${pseudocount.toFixed(2)}`);
  });

  it("describes the same RPM+p score and four-term variance used by targeted analysis", () => {
    expect(TARGETED_NANOPORE_METHODS.pvalueMethod).toContain("four-term");
    const formulas = TARGETED_NANOPORE_METHODS.sections
      .flatMap((section) => section.columns)
      .map((column) => column.formula ?? "")
      .join("\n");
    expect(formulas).toContain("RPM_<r>+p");
    expect(formulas).toContain("q_i=p×N_i/10⁶");
    expect(formulas).not.toContain("Count_<r>+p");
  });
});
