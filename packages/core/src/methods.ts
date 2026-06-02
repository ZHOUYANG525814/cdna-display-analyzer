// Column-by-column documentation for the analyzer CSVs. The same structured
// data feeds two consumers:
//
//   - Text formatter `formatMethodsAsText(doc)` — appended to the
//     QC_Summary_Report.txt download so the artifact is self-documenting.
//   - React component `<MethodsCard>` on the Results page — shows formulas
//     next to the data so users don't have to dig for definitions.
//
// Kept in `packages/core/` (not the web app) so the desktop CLI and any
// future server-side build can render the same documentation.
//
// Each `ColumnDoc` carries:
//   - name:    column name in the CSV
//   - summary: one-line plain-English explanation
//   - formula: math expression in Unicode (renders cleanly in monospace)
//   - notes:   optional caveats / pointers
//
// Documentation strings are intentionally written as I'd want them to read
// in a manuscript's methods section. The summary is for skim; the formula
// is for precision; the notes are for "when does this break or surprise me."

export interface ColumnDoc {
  /** Column name with `<r>` placeholder for round-name interpolation. */
  name: string;
  /** Plain-English one-line summary. */
  summary: string;
  /** Math expression (Unicode operators, monospace-friendly). Optional —
   *  some columns (Peptide_Seq, Count_<r>) are self-explanatory. */
  formula?: string;
  /** Caveats, edge cases, or pointers to related output. */
  notes?: string[];
}

export interface MethodsDocument {
  /** Short tool name for the document header. */
  toolName: string;
  /** Pseudocount used in all log2 fold-change and Z computations. 1.0 in our
   *  pipeline; Enrich2 uses 0.5. Surfaced because changing this changes
   *  every numeric column. */
  pseudocount: number;
  /** Name + short description of the p-value test. */
  pvalueMethod: string;
  /** Name + short description of the multiple-testing adjustment. */
  fdrMethod: string;
  /** Centering scheme for the tier-3 score. */
  centeringMethod: string;
  /** Grouped column documentation. */
  sections: { title: string; columns: ColumnDoc[] }[];
  /** Method-level caveats every user should see. */
  caveats: string[];
}

// ============================================================================
// cDNA-DISPLAY methods document
// ============================================================================

export const CDNA_METHODS: MethodsDocument = {
  toolName: "cDNA-DISPLAY Analyzer",
  pseudocount: 1.0,
  pvalueMethod:
    "Two-sided Wald z-test on the log2 fold-change, using a Poisson delta-method SE",
  fdrMethod: "Benjamini-Hochberg per round (independently across all variants in that round)",
  centeringMethod: "Library median of Enrich_Global at each round (robust against hit outliers)",
  sections: [
    {
      title: "Variant identity",
      columns: [
        {
          name: "Peptide_Seq",
          summary: "Translated amino-acid sequence of the CDS region using the standard genetic code.",
          formula: "Peptide_Seq = translate(Dominant_DNA_Seq)",
          notes: [
            "Translation is codon-by-codon (3 bp → 1 AA); a trailing partial codon maps to 'X'.",
            "Stop codons translate to '*'. With \"Discard CDS with premature stop\" on (default), no '*' appears.",
          ],
        },
        {
          name: "Dominant_DNA_Seq",
          summary:
            "The DNA codon variant most frequently observed for this peptide, summed across all rounds.",
          formula:
            "Dominant_DNA_Seq = argmax over { distinct DNAs encoding this peptide } of (total count across rounds)",
          notes: [
            "Ties are broken by first-seen order in the demultiplex stream (matches Python's max() semantics).",
            "Multiple synonymous codons may encode the same peptide; we keep just the dominant one for CSV readability.",
          ],
        },
      ],
    },
    {
      title: "Raw and normalized counts",
      columns: [
        {
          name: "Count_<r>",
          summary: "Reads passing every QC filter that translate to this peptide in round <r>.",
          notes: [
            "This is the raw data. Every other numeric column derives from it.",
            "Filter chain: mean read Phred ≥ threshold → Fw anchor exact 10-bp match → barcode score ≤ 1.0 → ambiguity margin ≥ 1.0 → CDS slice in-bounds → CDS-region mean Phred ≥ threshold → frame check → stop check (if enabled).",
          ],
        },
        {
          name: "RPM_<r>",
          summary: "Reads per million, normalized by the round's passed-QC count.",
          formula: "RPM_<r> = (Count_<r> / passed_qc_<r>) × 10⁶",
          notes: [
            "passed_qc_<r> is the per-round QC-passing total (see run_stats.json → rounds.<r>.passed_qc).",
            "Use RPM (not Count) to compare across rounds with different sequencing depths.",
          ],
        },
      ],
    },
    {
      title: "Enrichment (fold-change)",
      columns: [
        {
          name: "Enrich_Step_<curr>_vs_<prev>",
          summary: "log2 fold-change between two consecutive rounds.",
          formula: "Enrich_Step = log₂((RPM_<curr> + 1) / (RPM_<prev> + 1))",
          notes: [
            "Pseudocount of 1.0 keeps the formula defined when one round has zero reads for this variant.",
            "Useful for \"did this variant suddenly jump between rounds 2 and 3?\" diagnostics.",
          ],
        },
        {
          name: "Enrich_Global_<r>_vs_<first>",
          summary:
            "log2 fold-change vs the first round (the input library). The headline enrichment number.",
          formula: "Enrich_Global = log₂((RPM_<r> + 1) / (RPM_<first> + 1))",
          notes: [
            "This column is the CSV's primary sort key. Top rows = most enriched at the final round.",
            "Positive values = enriching; negative = depleting; ~0 = neutral / sampling noise.",
          ],
        },
        {
          name: "Centered_Enrich_<r>_vs_<first>",
          summary:
            "Library-median-centered enrichment. Corrects systematic library-wide drift (e.g., sequencing-depth differences between rounds).",
          formula:
            "Centered_Enrich = Enrich_Global − median(Enrich_Global across all variants at round <r>)",
          notes: [
            "Median (not mean) so a small number of strong hits doesn't pull the offset and falsely flatten them.",
            "CAVEAT: under stringent selection where most variants drop out, the library median itself is strongly negative — Centered_Enrich over-corrects and makes everything look enriched.",
            "Check the library median in run_stats.json → library_median_enrich. If any value is more negative than ~−1, treat Centered_Enrich with skepticism for that round.",
          ],
        },
      ],
    },
    {
      title: "Statistical inference (Z / p-value / FDR)",
      columns: [
        {
          name: "Z_Enrich_<r>_vs_<first>",
          summary:
            "Z-statistic — how many standard errors the log2 fold-change is from zero.",
          formula:
            "Z = Enrich_Global / SE,  where  SE = (1/ln 2) · √[ 1/(Count_<r> + 1) + 1/(Count_<first> + 1) ]",
          notes: [
            "Poisson delta-method SE. Anti-conservative for counts below ~5; pseudocount mitigates but doesn't fully fix.",
            "SE is not emitted as a separate column — derivable on demand as `Enrich_Global / Z`.",
            "Rule of thumb: |Z| > 2 → suggestive; |Z| > 3 → confidence; |Z| > 5 → strong (modulo multiple testing — use FDR_q).",
          ],
        },
        {
          name: "Pval_Enrich_<r>_vs_<first>",
          summary: "Two-sided z-test p-value under the null hypothesis Enrich_Global = 0.",
          formula: "P = 2 · (1 − Φ(|Z|)),  Φ = standard normal CDF",
          notes: [
            "Two-sided because the test is \"is the variant changing\", not \"is it specifically enriching\".",
            "For a one-sided enrichment-only test, see the Volcano plot panel (Fisher's exact right-tail).",
          ],
        },
        {
          name: "NegLog10Pval_Enrich_<r>_vs_<first>",
          summary: "−log₁₀ of the raw p-value. Useful for volcano-plot Y-axis and quick significance scoring.",
          formula: "NegLog10Pval = −log₁₀(Pval)",
          notes: [
            "1.30 ↔ p = 0.05;  2.00 ↔ p = 0.01;  3.00 ↔ p = 0.001.",
            "Clamped at 300 to avoid +∞ from double-precision underflow on extremely small p-values.",
          ],
        },
        {
          name: "FDR_q_<r>_vs_<first>",
          summary:
            "Benjamini-Hochberg adjusted q-value — the false-discovery-rate threshold at which this variant is significant.",
          formula:
            "Sort all variants ascending by p. For rank i (1-based), q[i] = min over k ≥ i of (p[k] · m / k). Cap at 1. Monotonicity correction applied from the largest rank downward.",
          notes: [
            "Use q < 0.05 as the conventional significance cutoff for hit-calling.",
            "Computed independently per round — q for R3 vs R0 is separate from q for R2 vs R0.",
            "FDR controls the *expected fraction* of false positives among called hits. With 100 hits at q<0.05, expect ≤ 5 to be false discoveries.",
          ],
        },
      ],
    },
  ],
  caveats: [
    "Pseudocount = 1.0 in every log2-based column. Enrich2 / DiMSum use 0.5; the choice affects very-low-count variants. We picked 1.0 for self-consistency with the existing Enrich_* columns.",
    "All Z / p-values are Wald-type (score / SE) from a Poisson delta-method. The Wald approximation is anti-conservative at very low counts. For publication-grade extremes, a Fisher's exact CI or beta-binomial test would be more rigorous; we can add either later.",
    "Centered_Enrich assumes \"most variants are neutral\". When stringent selection eliminates most variants, the library median is shifted away from zero and the centered score over-corrects. Library median is reported in run_stats.json so users can detect this regime.",
    "FDR and rank are computed across the *full library* at each round, not just over the rows in the CSV. (The analyzer always processes every observed peptide.)",
  ],
};

// ============================================================================
// Nanopore SSM methods document
// ============================================================================
//
// Differences from cDNA:
//   - Variable region is called "ROI" (between two flanking anchors), not "CDS".
//   - WT counter is available → tier-2 score (Fitness_vs_WT) is the Enrich2 L_v
//     formula. Anchors all statistical inference on this column.
//   - Dual-anchor scoring uses banded approximate matching (Wagner-Fischer) to
//     tolerate Nanopore's per-base error rate.

export const NANOPORE_METHODS: MethodsDocument = {
  toolName: "Nanopore SSM Analyzer",
  pseudocount: 1.0,
  pvalueMethod:
    "Two-sided Wald z-test on the log2 WT-anchored fitness, using a four-term Poisson delta-method SE",
  fdrMethod: "Benjamini-Hochberg per (site, round) — each site is treated as an independent experiment",
  centeringMethod: "Library median of Fitness_vs_WT at each (site, round) (robust against hit outliers)",
  sections: [
    {
      title: "Variant identity",
      columns: [
        {
          name: "Site",
          summary: "Name of the SSM site this variant belongs to (one row per (site, AA-variant) pair).",
          notes: [
            "Each site has its own flanking anchors, expected ROI length, and WT codon. Rows for different sites are independent — sort and significance are scoped per-site.",
          ],
        },
        {
          name: "Variant_AA",
          summary: "Translated amino-acid for this ROI (1 codon = 1 AA for typical 3-bp SSM sites).",
          formula: "Variant_AA = translate(Dominant_DNA)",
        },
        {
          name: "Dominant_DNA",
          summary:
            "The DNA codon variant most frequently observed for this AA at this site, summed across rounds.",
        },
      ],
    },
    {
      title: "Counts and normalization",
      columns: [
        {
          name: "Count_<r>",
          summary:
            "Reads passing every Nanopore-side QC filter that extract this exact ROI sequence at this site in round <r>.",
          notes: [
            "Filter chain: mean read Phred ≥ minMeanPhredRead → both anchors located by banded align (subs ≤ maxAnchorSubs, indels ≤ maxAnchorIndels) → ROI length == expected (no Nanopore indels in the variable region) → mean ROI Phred ≥ minMeanPhredRoi → frame check → stop check (if enabled).",
          ],
        },
        {
          name: "RPM_<r>",
          summary: "Reads per million, normalized by this site's passed-QC count for round <r>.",
          formula: "RPM_<r> = (Count_<r> / passed_qc_<site,r>) × 10⁶",
          notes: [
            "Per-site denominator: passed_qc is tracked per (site, round) because sites can fail independently (one anchor matches but the other doesn't).",
          ],
        },
      ],
    },
    {
      title: "Enrichment and fitness",
      columns: [
        {
          name: "Enrich_Global_<r>",
          summary:
            "Tier-1 score: log2 fold-change of RPM vs round 0. Intuitive but doesn't use the WT counter.",
          formula: "Enrich_Global = log₂((RPM_<r> + 1) / (RPM_<first> + 1))",
        },
        {
          name: "Fitness_vs_WT_<r>",
          summary:
            "Tier-2 score: log2 WT-anchored fitness. The Enrich2 L_v formula. Compares the variant's frequency relative to WT in each round.",
          formula:
            "Fitness_vs_WT = log₂[ (Count_v_<r> + 1) / (wt_<r> + 1) ]  −  log₂[ (Count_v_<first> + 1) / (wt_<first> + 1) ]",
          notes: [
            "wt_<r> = number of reads at this site whose ROI exactly matches the reference WT in round <r> (separate counter, see run_stats.json → rounds.<r>.sites.<siteName>.wt_count).",
            "Positive = variant outgrows WT; negative = variant is selected against relative to WT; ~0 = variant tracks WT.",
            "Preferred over Enrich_Global because it cancels per-round library-size effects directly via the WT denominator.",
          ],
        },
        {
          name: "Centered_Fitness_<r>",
          summary:
            "Tier-3 score: library-median-centered fitness. Corrects any residual library-wide shift not absorbed by WT normalization.",
          formula:
            "Centered_Fitness = Fitness_vs_WT − median(Fitness_vs_WT across all variants at this (site, round))",
          notes: [
            "Per-(site, round) median because sites are independent experiments.",
            "Same dropout caveat as cDNA: under stringent selection, median may be strongly negative.",
            "Library median per (site, round) is exposed on the analyzer result as libraryMedianFitness.",
          ],
        },
      ],
    },
    {
      title: "Statistical inference",
      columns: [
        {
          name: "Z_Fitness_<r>",
          summary: "Z-statistic for Fitness_vs_WT — distance from neutral in units of SE.",
          formula:
            "Z = Fitness_vs_WT / SE,  where  SE = (1/ln 2) · √[ 1/(Count_v_<r> + 1) + 1/(wt_<r> + 1) + 1/(Count_v_<first> + 1) + 1/(wt_<first> + 1) ]",
          notes: [
            "Four-term Poisson SE — all four counts (variant + WT, both rounds) contribute. Larger denominator than the cDNA two-term form by construction.",
            "Anti-conservative when any of the four counts is < ~5.",
            "WT-counter dependency: when the WT count is very low (synthesis dropout at the WT codon), the SE inflates for everyone at that site.",
          ],
        },
        {
          name: "Pval_Fitness_<r>",
          summary: "Two-sided z-test p-value for Fitness_vs_WT.",
          formula: "P = 2 · (1 − Φ(|Z|))",
        },
        {
          name: "NegLog10Pval_Fitness_<r>",
          summary: "−log₁₀ of the raw p-value for volcano-style rendering. Clamped at 300.",
        },
        {
          name: "FDR_q_<r>",
          summary:
            "Benjamini-Hochberg adjusted q-value, computed per (site, round). The standard hit-calling threshold is q < 0.05.",
          notes: [
            "Site-scoped: each site's variants form their own multiple-testing family. q for site_1 isn't affected by p-values at site_2.",
          ],
        },
      ],
    },
  ],
  caveats: [
    "Pseudocount = 1.0 in every log2-based column. Enrich2 uses 0.5; the choice mainly affects very-low-count variants.",
    "Wald-type Z is anti-conservative at any count < ~5. The pseudocount mitigates but does not eliminate this. For variants with Count_<first> < 5, treat the FDR as a lower bound on the true significance level.",
    "Banded anchor matching tolerates up to maxAnchorSubs substitutions + maxAnchorIndels indels per anchor (defaults: 2 + 1). Variants that fail this tolerance are dropped from the counter entirely, not counted as zero — so a variant absent from the CSV could be either truly absent or repeatedly anchor-failed.",
    "WT counter assumes the reference ROI string is what truly counts as WT in your library. If your library has a synonymous-codon WT (e.g., GCT and GCG both encoding the WT Ala), only the reference-matching codon feeds wt_<r>; you may want to verify wt_count_<r> is large enough (≥ 100 typically) for the WT-anchored fitness to be stable.",
  ],
};

// ============================================================================
// Text formatter (writes the methods section into QC_Summary_Report.txt)
// ============================================================================

/** Render a MethodsDocument as plain text, suitable for appending to the QC
 *  summary report. Layout matches the surrounding `=`-separator style.
 *
 *  @param doc           The static column documentation.
 *  @param runParams     Per-run parameters to include (settings the user
 *                       chose, library median values, etc.). All optional
 *                       — passing none still produces a useful column
 *                       reference, just without the run-specific lines.
 */
export interface MethodsRunParams {
  /** Settings the user picked for this run, formatted as key→value strings.
   *  E.g. `{ "Mean read Phred": "≥ 20.0", "Use WASM": "yes" }`. Rendered in
   *  insertion order. */
  settings?: ReadonlyArray<{ label: string; value: string }>;
  /** Library median values per round (or per site:round for Nanopore). */
  libraryMedian?: Record<string, number>;
  /** Hit counts per round at standard FDR thresholds. */
  hitCounts?: ReadonlyArray<{ label: string; q05: number; q01: number; total: number }>;
}

export function formatMethodsAsText(
  doc: MethodsDocument,
  runParams: MethodsRunParams = {},
): string {
  const lines: string[] = [];
  const sep = "=".repeat(85);
  const sub = "-".repeat(85);

  lines.push(sep);
  lines.push(`                METHODS & COLUMN REFERENCE — ${doc.toolName}`);
  lines.push(sep);
  lines.push("");

  // --- Per-run parameters (if supplied) -----------------------------------
  if (runParams.settings && runParams.settings.length > 0) {
    lines.push("--- This run's settings ---");
    for (const s of runParams.settings) {
      lines.push(`  ${s.label.padEnd(32)}  ${s.value}`);
    }
    lines.push("");
  }

  // --- Headline method choices -------------------------------------------
  lines.push("--- Method choices ---");
  lines.push(`  Pseudocount                       ${doc.pseudocount.toFixed(2)}`);
  lines.push(`  p-value test                      ${doc.pvalueMethod}`);
  lines.push(`  Multiple-testing correction       ${doc.fdrMethod}`);
  lines.push(`  Centering scheme (tier-3 score)   ${doc.centeringMethod}`);
  lines.push("");

  if (runParams.libraryMedian && Object.keys(runParams.libraryMedian).length > 0) {
    lines.push("--- Library-wide median (diagnostic) ---");
    lines.push("  Values far from zero flag a systematic library-wide shift.");
    lines.push("  Strongly negative (< −1) flags the dropout regime where Centered_* over-corrects.");
    for (const [key, val] of Object.entries(runParams.libraryMedian)) {
      const warn = val < -1 || val > 1 ? "  ⚠ flagged" : "";
      lines.push(`  ${key.padEnd(60)}  ${val.toFixed(3)}${warn}`);
    }
    lines.push("");
  }

  if (runParams.hitCounts && runParams.hitCounts.length > 0) {
    lines.push("--- Hit counts at standard FDR thresholds ---");
    lines.push(`  ${"comparison".padEnd(40)}  ${"q<0.05".padStart(10)}  ${"q<0.01".padStart(10)}  ${"of total".padStart(10)}`);
    lines.push("  " + "-".repeat(75));
    for (const h of runParams.hitCounts) {
      lines.push(
        `  ${h.label.padEnd(40)}  ${h.q05.toString().padStart(10)}  ${h.q01.toString().padStart(10)}  ${h.total.toString().padStart(10)}`,
      );
    }
    lines.push("");
  }

  // --- Per-column documentation ------------------------------------------
  for (const section of doc.sections) {
    lines.push(`--- ${section.title} ---`);
    lines.push("");
    for (const col of section.columns) {
      lines.push(`  ${col.name}`);
      lines.push(`    ${col.summary}`);
      if (col.formula) {
        lines.push("");
        lines.push(`    Formula:  ${col.formula}`);
      }
      if (col.notes && col.notes.length > 0) {
        lines.push("");
        for (const note of col.notes) {
          lines.push(`    · ${note}`);
        }
      }
      lines.push("");
    }
  }

  // --- Caveats ------------------------------------------------------------
  if (doc.caveats.length > 0) {
    lines.push("--- Caveats ---");
    lines.push("");
    for (const c of doc.caveats) {
      lines.push(`  · ${c}`);
    }
    lines.push("");
  }

  lines.push(sub);
  lines.push("End of methods reference.");
  lines.push("");

  return lines.join("\n");
}
