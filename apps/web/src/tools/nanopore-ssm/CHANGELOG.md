# Nanopore SSM tool — changelog

All material changes (features, fixes, refactors, design decisions) to the
Nanopore SSM tool land here in reverse-chronological order. Bumped on every
update, including small fixes. References the broader plan in
[/.claude/plans/this-is-the-code-deep-sun.md] under "Phase 6".

Date format: `YYYY-MM-DD`.

---

## 2026-06-02 — Phase 6.16.1 — Hierarchical viz sampling + gzip download

User-driven follow-up to keep three cDNA viz cards looking dense and
useful at million-peptide scale, plus a long-requested bandwidth win on
the download path. Nanopore Results page is unchanged.

### Hierarchical sampling (cDNA viz)

Three charts were vulnerable to "ugly when top-K-sampled" failure modes:

  - **Volcano** — previously kept all significant points + stride-sampled
    background. If a Top-20 row didn't clear the FDR/LFC visual gate, it
    could be dropped from the plot even though it shows up in the Top-20
    table on the same page. New: always include first 20 rows by sort
    order, *then* all significant points, then stride sample.
  - **Enrichment scatter** — `HIGHLIGHT_TOP` dropped 50 → 20 so the red-
    highlighted cohort matches the Top-20 table exactly.
  - **Count histogram + rank-abundance feed** (in csvParse.ts):
    `countsByRound` now uses *hierarchical* sampling, not pure reservoir.
    Top-K-by-count per round (K = 20) is kept deterministically alongside
    the 30k reservoir. At ~3.6M peptides the reservoir's per-rank hit
    probability is ~0.0001 — the right tail of the count histogram was
    effectively empty without the deterministic head.

### Top-20 table

GC% column removed (low-utility, derivable from `Dominant_DNA_Seq` if
ever needed). One fewer column = the round-RPM columns get more room
without overflow on narrow viewports.

### gzip download (.csv.gz)

New checkbox in the Downloads card: "gzip CSV (~6× smaller)". When ticked,
the CSV blob is streamed through `CompressionStream("gzip")` (browser-
native API, Chrome 80+ / FF 113+ / Safari 16.4+ — zero bundle cost) and
downloaded as `<project>_Master_Enrichment_Matrix.csv.gz`. Pandas reads
this natively via `pd.read_csv("file.csv.gz")`.

For the user's earlier 758 MB CSV, gzip drops it to ~120 MB on typical
enrichment-matrix patterns (highly repetitive round names, numeric cells).
Compression runs streamed, so the main thread stays responsive even on
multi-GB CSVs. The other two artifacts (run_stats.json, QC report) are
already small enough to ship uncompressed.

---

## 2026-06-02 — Phase 6.16 — σ² column for ML weights; drop redundant columns

User-driven schema change to support downstream machine-learning workflows
(e.g. ESM-2 PLM embedding → regression with inverse-variance weights).
Same set of changes applied to both per-site and haplotype CSVs.

### Added: σ² of the WT-anchored fitness

  - `Var_Fitness_<r>` — four-term Poisson δ-method variance of
    `Fitness_vs_WT_<r>`:

    ```
    Var_Fitness = (1/ln 2)² × [ 1/(Count_v_<r> + 1) + 1/(wt_<r> + 1)
                              + 1/(Count_v_<first> + 1) + 1/(wt_<first> + 1) ]
    ```

    Mathematically identical to `Z_Fitness × √Var_Fitness = Fitness_vs_WT`
    (same σ² already used internally to compute Z). Exposed as a column so
    downstream ML can weight rows by `1 / Var_Fitness` directly.

### Removed: `Enrich_Global_<r>` and `NegLog10Pval_Fitness_<r>`

  - `Enrich_Global_<r>` (the raw RPM-based log₂ fold-change) recoverable as
    `log₂((RPM_<r>+1)/(RPM_<first>+1))`. For Nanopore selections where the
    WT codon is identifiable, `Fitness_vs_WT_<r>` and `Centered_Fitness_<r>`
    are the preferred normalizations anyway (the WT denominator cancels
    per-round library-size shifts directly).
  - `NegLog10Pval_Fitness_<r>` is `−log₁₀(Pval_Fitness_<r>)` — one column
    away from any consumer that needs it for volcano-plot Y-axes.
  - Net CSV width: same number of stat columns per non-first round
    (Z / Pval / FDR_q / Var instead of Z / Pval / NegLog10Pval / FDR_q),
    plus one fewer fold-change column (Centered_Fitness only — raw
    Fitness_vs_WT kept since it's tier-2 in our 3-tier hierarchy).

### Sort key

Switched from `Fitness_vs_WT_<lastRound>` to `Centered_Fitness_<lastRound>`.
Same ordering by construction (centering subtracts a constant per
(site, round)) — anchored on the column users see in the CSV.

### Methods doc + MethodsCard

  - `Var_Fitness` ColumnDoc added with the four-term formula and the
    Poisson-δ-method derivation.
  - New `mlRecipe` section explicitly names (X, y, weight) =
    (Variant_AA + neighbouring context → ESM-2,
     Centered_Fitness_<lastRound>,
     1 / Var_Fitness_<lastRound>). Pandas snippet included.
  - Caveats updated to document the removals and the fully-degenerate-
    library caveat (when there is no biological WT, `Fitness_vs_WT`
    should NOT be used — fall back to RPM normalization).

---

## 2026-06-02 — Phase 6.15.1 — Follow-up: matrix + counts caps lowered

The Phase 6.15 changes moved CSV parsing into the worker but the Results
page on a 3.6M-peptide / 758 MB-CSV run was still freezing. Root cause:
two size caps that were still too generous for that scale.

  - `tools/cdna-display/steps/ResultsStep.tsx`: `matrixLimit` 50,000 → 5,000.
    The Comlink structured-clone return shrinks ~10× — was the dominant
    cost after the worker finished parsing.
  - `tools/cdna-display/viz/csvParse.ts`: `COUNTS_CAP_PER_ROUND` 100,000 →
    30,000. The first-mount Gini sort + log10/min-max scan in RankAbundance
    / CountHistogram now finish in <50 ms per round instead of multi-hundred.

Both caps are well above what any downstream viz actually consumes (volcano
1.5k, scatter 2k, histogram 24 bins, rank-abundance 200 chart points), so
zero visible behavioural change.

## 2026-06-02 — Phase 6.15 — Results-page responsiveness on multi-GB CSVs

Triggered by a 10 GB / 758 MB-CSV cDNA run that froze the dashboard for
~30-60 s on first paint. The Nanopore tool itself is unchanged in this
phase, but it shares the pipeline worker with cDNA-DISPLAY; the worker
gained a generic `parseCsv` method that the cDNA Results page now uses
instead of parsing on the main thread. Nanopore can adopt the same hook
if/when its Results page starts streaming a multi-GB CSV.

### What changed (cDNA-side, listed for cross-tool context)

  - `worker/pipeline.worker.ts`: added `parseCsv(blob, opts)` method
    (Comlink-exposed) that wraps `streamParseEnrichmentBlob`. Main thread
    no longer freezes during the multi-second CSV walk.
  - `tools/cdna-display/viz/csvParse.ts`:
      - Per-round count arrays reservoir-sampled (Algorithm R) at 100k
        entries. True totals + distinct-peptide counts still tracked
        exactly via `totalsByRound` / `nByRound`.
      - Parser now captures `Pval_Enrich_*` and `FDR_q_*` cells into
        `PeptideRecord.pval` / `.fdr` so downstream viz can consume
        precomputed analyzer-side stats.
  - `tools/cdna-display/viz/VolcanoPlot.tsx`: when comparing dest-vs-first
    (matches every panel for 2 rounds + the global panel for ≥3 rounds),
    use the precomputed `pval` / `fdr` columns instead of recomputing
    Fisher's exact. Only the R_i-vs-R_{i-1} stepwise panels for i ≥ 2
    still call the on-the-fly p-value path. Scatter cap dropped 5000 → 1500.
  - New `components/LazyMount.tsx`: IntersectionObserver-based wrapper.
    Each cDNA Results viz card is now lazy-mounted so first-paint cost is
    paid per card as the user scrolls, not all at once.

If Nanopore's Results page hits the same first-paint freeze later, the
same three knobs apply: move parsing to the worker, reservoir-cap the
per-(site, round) count arrays, and lazy-mount the heavy charts.

---

## 2026-06-01 — Phase 6.14 — Methods card + column reference (both tools)

User asked for detailed math definitions for the non-intuitive columns — in
the downloadable summary file AND on the results webpage. Implements both:
the same structured documentation feeds the text and the UI.

### New file: `packages/core/src/methods.ts`

  - `MethodsDocument` interface: pseudocount, p-value method, FDR method,
    centering scheme, plus grouped column docs (`ColumnDoc[]` with name,
    summary, formula, notes) and run-level caveats.
  - `CDNA_METHODS` and `NANOPORE_METHODS`: ready-to-render documents for
    both tools. Each column documented with a plain-English summary, an
    explicit Unicode-formula line, and caveats / when-it-breaks notes.
  - `formatMethodsAsText(doc, runParams)`: pure-text renderer for the
    QC_Summary_Report.txt appendage. Layout matches the existing report's
    `=`-separator style. Interpolates run-specific parameters (settings,
    library median, hit counts) when supplied.

Documented columns include the ones that were genuinely opaque before:
`Centered_Enrich`, `Centered_Fitness`, `Z_*`, `Pval_*`, `NegLog10Pval_*`,
`FDR_q_*` — plus the headline ones (`Enrich_Global`, `Fitness_vs_WT`) for
completeness so users opening the summary file have one unified reference.

### Worker outcome wire types

Added `libraryMedianEnrich` (cDNA) and `libraryMedianFitness` (Nanopore),
plus `hitCounts: Array<{ label, q05, q01, total }>` to both outcomes.
Worker fills these from the analyzer's return and the FDR_q columns; no
re-parsing of the CSV on the main thread.

### BrowserExporter (cDNA)

`buildQcReport` now appends the methods + column reference. The downloaded
QC_Summary_Report.txt is self-contained: a reviewer or future-self can open
that one file and see exactly what every CSV column means + which knobs
were set.

Per-run parameters fed to the formatter:
  - Pipeline mode, WASM flag, Q thresholds, filterStop
  - `libraryMedianEnrich` per Enrich_Global column
  - `hitCounts` per comparison at q<0.05 and q<0.01

### New component: `apps/web/src/components/MethodsCard.tsx`

Shared by both tools. Renders the same `MethodsDocument` as an expandable
card on the Results page. Default-collapsed so the dashboard's main viz
stays above the fold; one click expands a five-section layout:

  1. This run (settings recap)
  2. Library median (per-round/per-site, flagged when |median| > 1)
  3. FDR hit counts table
  4. Method choices (pseudocount, p-value test, FDR, centering)
  5. Per-column documentation, grouped by section
  6. Caveats (rendered in a warning-toned block)

Cross-tool reuse: only the `doc` prop differs. Same layout, same UX.

### Mounted on both Results pages

  - cDNA `ResultsStep.tsx`: card inserted just below the Downloads card.
  - Nanopore `ResultsStep.tsx`: card inserted before the bottom button row.

### Tests + build

  - 148 core + 7 web tests pass.
  - Bundle: cDNA worker 79 KB (unchanged); web JS 1,184 KB (+ ~3 KB for
    the documentation strings, gzipped down to ~264 KB).

---

## 2026-06-01 — Phase 6.13 — Run-time logging + volcano hit annotations

Responds to user (and their professor's) feedback: a scientific tool should
show its work *during* the run, not just dump a summary at the end. Adds
structured logging through the entire stack and improves the volcano plot's
hit-count readability.

### Run-time log channel (both tools)

New `onLog` callback on `runPipeline` / `runNanoporePipeline` accepting
`{text, tag}` events. Wired all the way through `worker/types.ts` →
`workerClient.runInWorker` / `runNanoporeInWorker` → both tools' RunStep
dispatchers → store `appendLog` / `pushLog`. Each event is appended verbatim
to the UI's terminal-log panel with the matching colour.

Events emitted by the orchestrator, in order:

1. **Settings recap at start.** WASM on/off, filter thresholds, pseudocount,
   FDR method, plus a per-round (cDNA) or per-site (Nanopore) anchor preview
   so the user can verify the engine got the right primer / anchor strings.
2. **Per-source open.** "Source 1/2: opening HN01.fastq (5.2 GB)"
3. **Filter-funnel cadence every ~100k records.** Running breakdown of
   passed-QC / low-Q / no-anchor / ambig / barcode-mismatch / truncated /
   indel / stop / low-Q-CDS for cDNA, and per-site anchor-found / ROI-indel
   / low-Q-ROI for Nanopore. Lets users watch the engine work and catch a
   broken anchor / wrong primer mid-run instead of at the end of an 8-hour
   job.
4. **Per-source done summary.** "HN01.fastq done in 142s · 1.8M reads · 850k
   passed_qc · 23k unique CDS".
5. **Library-median diagnostic** (the new tier-3 score's normalization
   constant): one line per round. Tagged `warning` when |median| > 1 so
   the strong-dropout regime (where the centered score over-corrects) is
   visible.
6. **FDR summary.** "Round_3 vs Round_0: 245 variants with FDR < 0.05 (89
   with FDR < 0.01) out of 12,345 unique peptides". Per-site for Nanopore.
7. **Total runtime.**

Cadence chosen as 100k records (configurable in code as `LOG_EVERY`). Each
log call crosses the worker boundary individually, but at 100k-record
granularity the overhead is in the noise.

### Volcano plot: labeled threshold lines + dual-threshold hit badge

Existing volcano already had the FDR=0.05 reference line and a one-line hit
count. Three improvements:

- **Labels on the threshold lines.** Both the FDR=0.05 horizontal and the
  log₂FC=1 vertical lines now carry a small inline label so users don't
  have to know -log₁₀(0.05) ≈ 1.301 by memory.
- **Stricter FDR=0.01 line** when at least one variant clears it. Rendered
  in destructive-color with a different dash pattern. Suppressed entirely
  when no variant reaches it (avoids visual noise on flat data).
- **Dual-threshold hit badges.** Two pill badges: "N hits · FDR<0.05" and
  "M · FDR<0.01" (the strict count only shows when > 0).
- **Method footnote.** Single small caption: "Right-tail Fisher's exact
  (small counts) / Yates χ² (large counts) · BH-adjusted FDR". Disambiguates
  this from the CSV's `Z`/`p`/`FDR_q` columns (which use a Wald-type
  two-sided test). The two methods test different null hypotheses (the
  volcano is one-sided "enrichment specifically"; the CSV columns are
  two-sided "any change vs WT"), so the FDRs won't be identical — the
  footnote makes that explicit.

### Verified

  - Build: green (1.18 MB JS / 264 KB gz · worker bundle 79 KB)
  - 148 core tests + 7 web tests passing (no test changes needed — onLog is
    an optional callback; existing tests don't supply one)
  - Manual: settings recap and library-median appear in the terminal log
    immediately on run start; filter-funnel ticks at the expected cadence.

### What's deliberately NOT in this batch

  - Methods card on Results page (formulas + per-run params): user
    deprioritized for now in favor of these two items.
  - Column-name tooltips: same — defer to a later UX pass.
  - In-app result filter, SSM heatmap, codon-usage diagnostic: separate
    phases as discussed.

---

## 2026-06-01 — Phase 6.12 — Enrich2-style Z + p + FDR + CLR-centered score

Implements the three-tier enrichment design discussed with the user, modelled
on Rubin et al. 2017 (*Genome Biology*, Enrich2). Goal: keep the intuitive
log2 fold-change AND give users statistical inference + a systematic-shift
correction in the same CSV, without ballooning the column count.

### Schema changes (both tools)

**Removed** (derivable, low utility for CSV width):
- `Rank_<r>` — derivable from `Count_<r>` via a 5-line sort
- `GC_Percent` — derivable from `Dominant_DNA(_Seq)` via `calculateGc`
- `Present_In_All` (cDNA only) — derivable as `all Count_<r> > 0`

**Added per non-first round** (the round-0 baseline is identically 0 for these
metrics, so we don't emit them there):

| Column | Formula | Notes |
|---|---|---|
| `Centered_Enrich_<r>` (cDNA) / `Centered_Fitness_<r>` (Nano) | tier-1 score − **library median** of that score at the round | CLR-style normalization; median chosen over mean for robustness against hit outliers |
| `Z_<score>_<r>` | score / SE | SE = Poisson delta-method on counts, pseudocount 1.0 (matches existing log2 columns) |
| `Pval_<score>_<r>` | 2·(1 − Φ(\|Z\|)) | Two-sided z-test, null = "variant behaves like WT" |
| `NegLog10Pval_<score>_<r>` | −log10(p) | Direct for volcano-plot rendering |
| `FDR_q_<r>` | Benjamini-Hochberg over all variants in that round | Per round (and per site for Nanopore) |

`SE_<score>_<r>` is deliberately NOT emitted — it's derivable as
`score / Z`, and the column would add width without serving readers.

### Anchoring

- **cDNA NGS**: Z / p anchored on `Enrich_Global_<r>_vs_<first>` (no explicit
  WT counter; SE uses two-count Poisson form).
- **Nanopore**: Z / p anchored on `Fitness_vs_WT_<r>` (four-count Poisson SE
  with WT terms, exactly the Enrich2 L_v form). FDR is computed per (site,
  round) — each site is a separate experiment.

### Library median exposed

The library-wide median of the score at each round is surfaced:
- cDNA: `library_median_enrich` block in `run_stats.json` (schema_version
  bumped 1 → 2, key is optional so single-round runs stay clean)
- Nanopore: `libraryMedianFitness` field on the analyzer result, keyed by
  `"<siteName>:<round>"` for per-site medians and `"__haplotype__:<round>"`
  for haplotype medians

Non-zero medians flag systematic library shifts. A strongly negative median
flags the "most variants dropped out" regime where `Centered_<score>` over-
corrects — surfacing the median lets users detect this honestly rather than
hiding it inside the centering.

### Net CSV-width impact (4-round run, both tools)

| Tool | Before | Removed | Added | After | Δ |
|---|---|---|---|---|---|
| cDNA | 22 cols | −8 | +15 | 29 | +7 |
| Nanopore | 24 cols | −4 | +15 | 35 | +11 |

Modest growth that fits the substantial inference gain.

### Method choices (each is defensible; document for users)

- **Pseudocount 1.0** for all log2-related computations (existing columns
  and new SE/Z). Enrich2 uses 0.5; we stay at 1.0 for self-consistency with
  the unchanged log2 columns. Both are standard; difference negligible
  except at very low counts.
- **Wald-type Z (score / SE) from Poisson delta-method.** Anti-conservative
  at counts < ~5; the pseudocount mitigates. Acceptable for moderate counts;
  Fisher's exact CI would be more rigorous and can be added later.
- **BH-FDR**, not Storey q-value. BH is exact under independence; Storey
  is more powerful but assumes a π0 estimator we don't currently fit.
- **Median centering**, not mean. Robust against the small-N strong-hit
  outliers. Documented failure mode: under stringent selection where most
  variants drop out, the library median itself is strongly negative and
  the centered score over-corrects toward enrichment.

### Tests

- New `test/stats.test.ts`: normalCdf vs z-table values, two-sided p at
  standard thresholds, BH textbook example, median NaN-tolerance.
- `analyzer.test.ts`: header expectations updated; two new tests for Z/p/q
  shape and signal-vs-noise discrimination.
- `nanopore-analyzer.test.ts`: header expectations updated.
- `parity.test.ts`: byte-for-byte CSV parity vs desktop Python relaxed to
  **subset parity on shared columns** (Peptide_Seq, Count_*, RPM_*,
  Enrich_*). `run_stats.json` parity uses field-by-field comparison on
  unchanged blocks since `schema_version` and `library_median_enrich` are
  intentional additions. The algorithmic contract (read-acceptance counters,
  Count + Enrich values for shared columns) is still byte-exact.
- `apps/web/test/localFastqSource.test.ts`: same subset-parity update.

124+ core tests + 7 web tests still pass after the rewrite.

---

## 2026-06-01 — Phase 6.11 — Remove unreliable "Adaptive" toggle (cDNA tool)

User reported that unchecking the "Adaptive: allow length variation
(in-frame indels)" toggle in the cDNA Configure step produced a "disaster"
on a real per-round run — yield collapsed, `discard_length_indel` spiked.

Root cause: the non-adaptive code path runs an **exact 10-bp Rv-anchor
scan** over the read tail, searching from `bestFwEndIdx` forward, and drops
the read whenever the anchor is found *anywhere* before `cdsEndAbs`. Two
compounding flaws:

1. **Positional-blind search.** `indexOfBytes` returns the first occurrence
   of the 10-mer anywhere after the Fw anchor, not the match at the
   expected post-ROI position. For a 69-bp ROI that's 60 candidate windows.
   A random match probability of ~6×10⁻⁵ per read sounds tiny, but real
   libraries are not random — short repeats, AT-biased linkers, or any
   incidental homology between the Rv primer's RC prefix and the ROI
   itself drives the false-positive rate to near 100%, dropping nearly
   every read.
2. **Exact match punishes clean reads.** A single sequencing sub in the
   anchor returns `rvIdx = -1`, which makes the check pass (skip). So
   high-quality reads receive the strict gate; noisy reads silently
   bypass it. Exactly backwards from what the user wants.

The check was also redundant: SSM/cDNA-display variable regions are
substitution-only by design, and the engine's frameshift check is computed
on the *configured* `cdsEnd − cdsStart + 1` length, not the observed read
content, so it can't detect per-read indels regardless.

**Action:**
- Removed the "Adaptive" toggle from `cdna-display/steps/ConfigureStep`.
- Hardcoded `adaptive: true` in `cdna-display/steps/RunStep` so the engine
  always skips the brittle path.
- Left the `adaptive` field on the engine settings and on the store — the
  desktop-Python parity test exercises both branches and we don't want to
  break that contract. The dispatcher just never sends `false` from the
  web UI again.

The Nanopore tool is unaffected (its dual-anchor scorer uses banded
alignment, not exact match).

---

## 2026-06-01 — Phase 6.10 — Lift CSV size ceiling (multi-GB FASTQ support)

User reported `ERROR: Invalid string length` on a per-round NGS run with two
FASTQs each > 5 GB. Root cause: the analyzer's `serializeCsv` joined every
row into one JS String via `lines.join("\n")`, which trips V8's hard
`~537 MB` single-string-length ceiling once the unique-peptide set is large
enough. A second copy of the same hazard sat in the cDNA Results dashboard,
where `csvBlob.text()` would have re-allocated the whole CSV as one string
even if the writer had succeeded.

Both pipelines (NGS + Nanopore) are now safe to multi-GB CSV output:

- **Writer**: `serializeCsv` returns `string[]` (one `"\n"`-terminated entry
  per line). `AnalyzerOutput.csv: string` → `csvParts: string[]`;
  `NanoporeAnalyzerOutput.perSiteCsv` / `haplotypeCsv` → `…CsvParts:
  string[]`. The worker now constructs Blobs via `new Blob(parts, …)` —
  Blob accepts a list of strings without concatenating them, so the bytes
  live in Blob-managed memory and never form one giant JS String.
- **Reader (cDNA dashboard)**: replaced `outcome.csvBlob.text()` with a new
  `streamParseEnrichmentBlob(blob, opts)` in `viz/csvParse.ts`. Uses
  `blob.stream()` + an incremental `TextDecoder`, processes records line-by-
  line with a carry buffer for partial-line bytes at chunk boundaries, and
  fills the top-N preview, capped matrix (50k rows), and full per-round
  count arrays in a single pass. The Nanopore Results dashboard only
  downloads its Blobs — no streaming change needed there.
- **Tests**: parity, analyzer, nanopore-analyzer, nanopore-2site, and the
  apps/web LocalFastqSource parity test all updated to use
  `parts.join("")` for byte-equality assertions on the 1k-read fixture.
  124 core tests + 7 web tests pass; the web build is green.

This removes the file-size cap entirely — the practical ceiling is now
overall heap pressure from the `dna_counters` Map, not the CSV writer.

---

## 2026-05-30 — Phase 6.9 — UX polish batch (typo / layout / tutorial)

Round of feedback from the deployed app. All 8 user-reported items addressed:

1. **Header tool name**: cDNA tool's `shortName` flipped from `cDNA-display`
   to `NGS` so the upper-right pill switcher reads `NGS` ⇄ `Nanopore`
   (platform-level distinction, parallel labels).
2. **Default project name**: both tools' stores now initialise
   `projectName: ""` so the placeholder `e.g. ...` is visible until the user
   types. (Was `"Unnamed_Project"` for cDNA.)
3. **UI width unification**: every Nanopore step's root `<div>` now uses
   `mx-auto max-w-4xl space-y-6`, matching the cDNA tool's container width
   exactly. The two tools now line up across the wizard.
4. **Logo → first step**: the upper-left icon + title are now a button.
   Reads `tool.useSetStep()` and jumps to `tool.steps[0].id`. Doesn't reset
   data; just navigates. Has a subtle hover scale + bg-muted background.
5. **NGS QC threshold**: `minMeanPhred` + `minMeanPhredCds` are now in
   `useRunStore` (default 20.0) and exposed as inputs in the cDNA Configure
   step's "Filters & settings" card. The RunStep dispatcher reads from the
   store instead of hardcoding 20.0.
6. **Site visualisation**: Nanopore Configure now shows a live assembly
   preview per site:
   - Per anchor ≥10 bp typed: a pairing-hint row indicating where the
     anchor matches in the reference (or that it doesn't).
   - For a fully aligned site: an `AssemblyBox` with the extracted ROI
     DNA + translated AA on top, plus 6 bp of flanking context. Lets the
     user see the codon they're about to count without leaving Configure.
7. **Tutorial mode for both tools**:
   - cDNA's existing "Try with demo data" button now stays on Sources
     (instead of jumping to Run) and lights up the prefilled card with a
     primary ring for 8s. Walk-through path: Sources → Configure → Preview
     → Run, with the user clicking through to see the data at each step.
   - Nanopore got a matching button + 1-site demo loader. New file
     [demo.ts](demo.ts) fetches the 3 round FASTQs from `/sample-data/`
     and pre-fills `sites[]`, `rounds[]`, `reference`, `projectName`.
   - Bundled FASTQs copied into `apps/web/public/sample-data/` (was only
     the cDNA's `sample_1k.fastq` before).
8. **CDS AA preview in NGS** + **ROI AA preview in Nanopore**:
   - NGS PreviewStep: new `CdsAaPreview` panel shows DNA + translated AA
     for the selected CDS region, with stop-codon warning when applicable.
   - Nanopore Configure: the new `AssemblyBox` already includes the
     translated AA over the ROI codons.

Engine + tests untouched. Builds: 1,184 KB JS / 263 KB gz (+15 KB / +3 KB gz
for the new UI features). Core tests still 124 passing.

## 2026-05-30 — Phase 6.8 — Fix: Drive sign-in in per-round mode + Cancel button

User-reported issues from the first browser test.

### Drive picker on per-round Configure was unreachable

- Symptom: in per-round mode, the "Pick from Drive…" button on each round's
  picker was permanently disabled.
- Root cause: the Sources step's MultiplexSources card (which carried the
  Drive sign-in path) is hidden in per-round mode, so the user had no way
  to authenticate. The Configure-side per-round picker requires a cached
  token in sessionStorage; with no path to sign in, the token was never
  cached, so `isDriveSignedIn()` stayed false and the button stayed disabled.
- Fix: added a standalone **DriveSignInCard** to the Sources step that's
  visible whenever Drive is configured AND pipeline mode is per-round.
  Shows a "Connected" badge once signed in (refreshes every 1s so the
  post-OAuth-return state flips automatically); offers a "Sign in to Google
  Drive" button that triggers the OAuth redirect when not signed in; and a
  Sign-out option when connected. With this card, the per-round Configure
  Drive picker now works as expected.
- File: [steps/SourcesStep.tsx](steps/SourcesStep.tsx).

### Cancel button on the Run step

- Mirrors the cDNA tool's pattern: `terminateWorker()` + status="cancelled"
  + warning log entry. The catch arm of `handleStart` now checks the current
  status before promoting Comlink's "worker terminated" rejection into an
  error — cancellation stays surfaced as `cancelled`, not error.
- The Start button now toggles to a destructive Cancel button while
  `status === "running"`.
- A new worker is spawned automatically on the next Start (the
  workerClient lazily reinstantiates after `terminateWorker()`).
- File: [steps/RunStep.tsx](steps/RunStep.tsx).

Both changes are UI-only; no engine touches, no test regressions
(124 passing, 2 skipped).

## 2026-05-30 — Phase 6.7 — 2-site fixture + smoke test + user configs

The haplotype path now has end-to-end test coverage on a synthetic library
that exercises real epistasis. The 1-site fixture from Phase 6.1 stays
untouched; the new 2-site fixture is parallel content under
[00_material/test_nanopore_2site/](../../../../../../00_material/test_nanopore_2site/).

- New fixture: 560 bp amplicon with two sites 400 bp apart (mimics
  K417 + E484 saturation studies).
  - Site 1 anchors: `GCAACTGGCTAGAATTCCG` / `GGAAGCTAGCGAATTCAAT`, WT codon GCT (Ala)
  - Site 2 anchors: `TTGACTGCATCGATATCC` / `AAGCAGGAATTCGCTAGC`, WT codon TAC (Tyr)
  - 3 rounds, 1000 reads total. Round_2 designed with strong **epistasis**:
    TGG_CTG (W_L double mutant) is 220 reads, far above what marginal
    site frequencies would predict.
  - Bad-read recipe includes `site2_missing` (truncated reads where only
    site_1 succeeds — validates partial-success not counting in haplotype)
    and `stop_in_roi1` (stop at site_1, fine at site_2 — same partial path).
- New test [/web/packages/core/test/nanopore-2site.test.ts](../../../../../../web/packages/core/test/nanopore-2site.test.ts):
  - Per-site `passed_qc` ≥ 80 % of design for BOTH sites in every round.
  - Haplotype counter populated in every round.
  - Round_2 top haplotype is `TGG_CTG`, ≥ 80 % of designed 220.
  - `haplotype_passed_qc` ≤ min(per-site passed_qc) in every round
    (validates partial-success reads don't sneak into the haplotype).
  - Top haplotype row by `Fitness_vs_WT_Round_2` is **W_L** — the
    epistasis signal the user is looking for.
- New user-facing config files (testing data for the deployed app):
  - [/00_material/test_nanopore/nanopore_config.yaml](../../../../../../00_material/test_nanopore/nanopore_config.yaml)
    + matching `.json` — paste-ready values for the 1-site fixture.
  - [/00_material/test_nanopore_2site/nanopore_config.yaml](../../../../../../00_material/test_nanopore_2site/nanopore_config.yaml)
    + matching `.json` — paste-ready values for the 2-site epistasis fixture.
  - Both include `expected_top_variants` / `expected_top_haplotypes`
    blocks so the user can sanity-check the run output without running the
    Python reference.
- Tests: 124 passing (+1 new), 2 skipped (bench), 0 failing. Core +
  web builds green.

## 2026-05-30 — Phase 6.6 — Wired Nanopore UI to the real engine

The Start button now actually runs. Mockup placeholders on Run + Results are
gone; both steps render real data from `runNanoporeInWorker`.

- [/web/apps/web/src/state/useNanoporeStore.ts](../../../../state/useNanoporeStore.ts):
  - Added run-state slice mirroring the cDNA store: `status`, `progress`,
    `perSourceBytes`, `startedAt`/`finishedAt`, `log[]`, `outcome`,
    `errorMessage`, plus `resetRun()` and granular setters.
  - `status` type: `"idle" | "running" | "done" | "error" | "cancelled"`.
- [/web/apps/web/src/tools/nanopore-ssm/steps/RunStep.tsx](steps/RunStep.tsx) (full rewrite):
  - Start button builds a `NanoporeJob` from the store, dispatches via
    `runNanoporeInWorker`, and registers a progress callback that fans out
    to `setProgress` + `setSourceBytes`.
  - Per-source progress bars driven by `perSourceBytes / totalBytes` per
    source (works for both local and Drive sources because the orchestrator
    fires progress events with byte counters).
  - Live log panel: `[HH:MM:SS] {msg}` with `info / success / warning / error`
    coloring (semantic colors stay shared with cDNA so meanings line up).
  - On success: outcome stored, transitions straight to Results step.
  - On Drive-token refresh failure: logged + status="error" without throwing.
  - Cancel + wake-lock deferred (cDNA has both; will copy the pattern next).
- [/web/apps/web/src/tools/nanopore-ssm/steps/ResultsStep.tsx](steps/ResultsStep.tsx) (full rewrite):
  - 4 stat cards: Passed QC (all sites), WT-baseline reads, Sites,
    Unique variants (top 200/site).
  - Per-round yield table — one row per round, columns = each site's
    passed_qc + each site's wt_count + (when ≥2 sites) haplotype_passed_qc.
  - Variant tables tabbed per site (top 50 from the 200-row preview),
    sorted by Fitness_vs_WT of the last round. WT badge on rows whose
    `Dominant_DNA` matches the resolved WT.
  - Haplotype tab when ≥2 sites enabled linkage tracking.
  - Download buttons emit `<projectName>__enrichment_per_site.csv` and
    `<projectName>__enrichment_haplotype.csv` Blobs from the outcome.
  - "New run" resets run state + jumps back to Sources.
- Removed unused [/web/apps/web/src/tools/nanopore-ssm/steps/_mockup.tsx](steps/_mockup.tsx)
  (the "UI preview, inputs inert" banner — Run/Results are now wired so it
  doesn't belong; the placeholder still appears via doc-comments only).
- Builds: 1,169 KB JS / 261 KB gz (+4 KB / +2 KB gz vs pre-wire). Worker
  bundle grew 40 KB → 68 KB (the engine + analyzer compiled in once,
  shared with all future runs).
- Core tests still 123 passing.

### What still needs polish
- No Cancel button yet — Start is fire-and-forget until the run finishes
  (matches Phase 4 cDNA behaviour at first; copying the AbortController +
  `terminateWorker()` pattern is a follow-up).
- Wake Lock on running tab: missing.
- Real-data smoke test against the 1k fixture in the actual browser worker
  (vs the Node-side test in Phase 6.3) is Phase 6.7.

Next: Phase 6.7 — extend the test fixture to a 2-site scenario (validates the
haplotype path end-to-end on real-ish data), then run the user-supplied
Nanopore FASTQs through the deployed app.

## 2026-05-30 — Phase 6.5 — Worker routing: `runNanopore` sibling method

The existing Comlink worker exposed one `run` method (cDNA). I added a sibling
`runNanopore` rather than discriminating one entry-point on a `tool` field —
simpler to read, no risk of breaking the cDNA call site, and a third tool
later just adds another method.

- [/web/apps/web/src/worker/types.ts](../../../../worker/types.ts):
  - New wire types: `NanoporeSiteWire`, `NanoporeRoundWire`, `NanoporeJob`,
    `NanoporeOutcome`. The job carries anchors as plain strings (engine
    encodes them) + a `Partial<NanoporeSettings>` override block; the outcome
    flattens engine Maps to records + wraps both CSVs as Blobs so postMessage
    crosses by reference, not by deep-copy.
  - `NanoporeOutcome` ships a `perSiteRowsPreview` (first 200 rows) for
    instant top-N display in the UI without re-parsing the CSV. Same idea
    for `haplotypeRowsPreview`.
  - `resolvedWtBySite` + `expectedRoiLenBySite` surfaced so the Results UI
    can badge WT rows and show "expected ROI length per site = N bp".
- [/web/apps/web/src/worker/pipeline.worker.ts](../../../../worker/pipeline.worker.ts):
  - Added `runNanopore(job, onProgress)`. Same boundary semantics as `run`:
    constructs `LocalFastqSource` / `DriveFastqSource` worker-side, wraps
    the Nanopore progress callback to add `fileName`, routes through
    `runNanoporePipeline`. Catches + logs exceptions with full stack so a
    stuck job is obvious in DevTools.
- [/web/apps/web/src/worker/workerClient.ts](../../../../worker/workerClient.ts):
  - Added `runNanoporeInWorker(job, onProgress)` — main-thread façade.
    Reuses the single persistent worker instance + the same __ready
    handshake the cDNA path uses.
- Both builds clean: `@cdna/core` + `@cdna/web` (1,165 KB JS / 259 KB gz —
  marginal increase for the new types and the second method).
- Existing tests still 123 passing; no new worker-level tests yet (Comlink
  RPC needs a real Worker which vitest can't host without browser-mode).
  The orchestrator tests in core cover everything the worker delegates to.
- Next: Phase 6.6 — wire the Nanopore Run/Results UI steps to call
  `runNanoporeInWorker`, show progress, render the per-site + haplotype
  results, and offer the CSV downloads.

## 2026-05-30 — Phase 6.4 — NanoporeAnalyzer with per-site + linked-haplotype CSVs

Final algorithm-side piece. The analyzer turns the engine's per-site DNA
counters + haplotype counters into two CSVs that the UI / exporter will
hand the user.

- New [/web/packages/core/src/nanopore-analyzer.ts](../../../../../../web/packages/core/src/nanopore-analyzer.ts):
  - `runNanoporeAnalyzer(input)` — one call, two outputs.
  - **Per-site CSV** (`enrichment_per_site.csv`, long format): one row per
    `(site, AA-variant)`, columns: `Site, Variant_AA, Dominant_DNA,
    GC_Percent, Count_<round>, RPM_<round>, Rank_<round>,
    Enrich_Global_<round>, Fitness_vs_WT_<round>`.
  - **Haplotype CSV** (`enrichment_haplotype.csv`, only when ≥2 sites +
    `emitHaplotype` was on): one row per joined-codon haplotype
    (`Haplotype_AA = "A_W"`, `Haplotype_DNA = "GCT_TGG"`), with the same
    metric columns.
  - Math:
    - `RPM = (count / passed_qc[round][site]) × 1e6`
    - `Enrich_Global_<round> = log2((RPM_round + 1) / (RPM_round_0 + 1))`
    - `Fitness_vs_WT_<round> = log2( ((c + 1)/(wt + 1)) / ((c_0 + 1)/(wt_0 + 1)) )`
      — DiMSum/Enrich2 convention with pseudocount 1.0 on every term so the
      formula is defined when a variant or WT has zero reads in any round.
  - Sort: by `Fitness_vs_WT_<lastRound>` desc, with `Variant_AA` asc tiebreaker.
  - Per-site WT counter is derived from `dnaCounters[round][site][wtDna]`,
    not from `stats.sites[site].wt_count` — the latter is only used by
    consumers that want a pre-computed total. The analyzer needs the
    per-round value so it can drive the round-by-round Fitness_vs_WT math.
  - Reuses the cDNA analyzer's `serializeCsv` + `ColumnSpec` types so both
    tools emit pandas-to_csv-compatible output (no trailing zero on
    integer floats, `True`/`False` for bools, sort-keys-style header).
- Wired into `runNanoporePipeline` so callers receive `result.analyzer`
  alongside the raw counters. The worker can ship just the analyzer payload
  to the main thread without recomputing.
- New tests [/web/packages/core/test/nanopore-analyzer.test.ts](../../../../../../web/packages/core/test/nanopore-analyzer.test.ts):
  - Single-site / single-round: emits one row per AA with correct RPM,
    rank, zero self-enrichment, zero WT-self-fitness.
  - Single-site / single-round with `emitHaplotype=true`: still emits no
    haplotype rows (gated on ≥2 sites).
  - Two-round / single-site: hand-computed `Fitness_vs_WT` matches the
    log2 expression to 1e-9; sort places enriched variant first.
  - Two-site / single-round: rows correctly partitioned per site; RPM
    denominators are per-site.
  - Two-site / two-round / haplotype: enriched double-mutant `W_L` ranks
    first with hand-computed `Fitness_vs_WT_R1` to 1e-9; WT haplotype
    `A_Y` has zero self-fitness.
  - CSV header validates exact column order.
- New public exports from `@cdna/core`: `runNanoporeAnalyzer`,
  `NanoporeAnalyzerInput`, `NanoporeAnalyzerOutput`, `NanoporeAnalyzerRow`.
- Test totals: 123 passing (+6 new), 2 skipped (bench), 0 failing.
- Next: Phase 6.5 — worker discriminated union to route either `runPipeline`
  (cDNA) or `runNanoporePipeline` (Nanopore) based on a `tool` field on the
  job payload.

## 2026-05-30 — Phase 6.3 — NanoporeEngine + runNanoporePipeline + tests

End-to-end algorithm assembly. The engine ties the dual-anchor scorer to the
per-read QC funnel and the per-site / haplotype counters; the orchestrator
mirrors `runPipeline` for cDNA (source-streaming, scratch-buffer reuse, RC
retry on no-site-extracted, progress callback).

- New [/web/packages/core/src/nanopore.ts](../../../../../../web/packages/core/src/nanopore.ts):
  - `NanoporeEngine` — per-read state machine. Per-call entry points are
    `processRead(seq, qual)` (multiplexed: barcode-match → bind to round)
    and `processReadForRound(seq, qual, idx)` (per-round: bound by caller).
  - Per-read funnel: read-Q gate → barcode match (multiplexed only) → for
    each site `{ scorer.score → ROI length check → ROI Q check → frameshift
    → stop }` → commit to `dnaCounters[round][site]` + `wt_count` if WT
    match → haplotype counter when all sites pass + reportHaplotype.
  - `createTsScorer(sites, settings)` — pure-TS fallback that calls
    `bandedAlign` twice per site. Same byte-output as the WASM scorer
    (parity-tested in Phase 6.2b).
  - `resolveWtRois(reference, sites)` — exact-match anchor scan over the
    user's reference to derive WT ROI + expected ROI length per site.
    Thrown errors are caught by the orchestrator.
  - `DEFAULT_SETTINGS` — SUP-R10.4 baseline: read Q ≥10, ROI Q ≥15,
    maxSubs=2, maxIndels=1, filterStop=true, reportHaplotype=true.
- New [/web/packages/core/src/nanopore-pipeline.ts](../../../../../../web/packages/core/src/nanopore-pipeline.ts):
  - `runNanoporePipeline(req)` — accepts `IFastqSource[]` + sites + rounds +
    reference + settings. Returns per-site dna counters, haplotype counters,
    per-round stats, and resolved site configs (for downstream analyzer).
  - Streams each source via the existing `readFastqRecords` async iterator;
    reuses `uppercaseInto` / `rcInto` / `reverseInto` / `copyInto` scratch
    buffers from the cDNA pipeline (same allocation pattern, no copy on
    fwd path).
  - RC retry fires only on outcomes `!== "assigned"` and `!== "low_quality_read"`
    — low-Q is a chemistry property, RC can't fix it.
  - Progress callback identical to `PipelineProgress` shape so the worker /
    UI can plug in unchanged.
  - WASM scorer used when `useWasm: true`; pure-TS fallback otherwise. Both
    paths are byte-identical (covered by the Phase 6.2b parity suite).
- Engine refactor: dropped per-round `total_reads` and `passed_read_q`
  counters. They were prone to RC-retry double-counting and the analyzer
  uses per-site `passed_qc` as its RPM denominator anyway. Mirrors how the
  cDNA `RoundStats` shape works (no `total_reads`; `total_assigned` only
  increments on successful binding).
- New tests:
  - [/web/packages/core/test/nanopore.test.ts](../../../../../../web/packages/core/test/nanopore.test.ts) — 14 engine
    unit tests covering happy path (WT vs variant; aggregation), every
    discard bucket (read-Q, no-anchor, ROI-indel, ROI-low-Q, stop codon),
    multiplexed barcode binding (assigned / mismatch / ambiguous tie), and
    multi-site haplotype emission (all-pass emits, partial-pass skips,
    reportHaplotype=false disables).
  - [/web/packages/core/test/nanopore-pipeline.test.ts](../../../../../../web/packages/core/test/nanopore-pipeline.test.ts)
    — end-to-end against the 1k-read fixture in
    [00_material/test_nanopore/](../../../../../../00_material/test_nanopore/).
    Asserts per-round passed_qc within 85 % of design target (loss is real:
    flank noise occasionally piles up inside the 3-edit anchor budget),
    asserts bad-read buckets fire at least the seeded count (they catch
    extra anchor-boundary-slip reads in addition to the seeded indels),
    asserts Round_2 top variant is TGG with the right magnitude.
- Test totals: 117 passing (+15 new), 2 skipped (bench), 0 failing.

### Algorithm note: anchor-boundary slip

When a Nanopore indel lands inside an anchor, the banded matcher returns a
match position that's shifted by 1 bp; the engine extracts a ROI that's
1 bp longer or shorter than expected, which is then rejected as
`discard_roi_indel`. This is structurally bounded — `maxIndels=1` per
anchor means at most 1 bp of slip per side per read — but it does mean
the per-site `discard_roi_indel` counter is an UPPER bound on
true-indel-in-ROI reads, not a precise count. A more precise approach
(anchor the match's END position rather than minimize edit distance)
would tighten this; deferred.

### Public surface

`@cdna/core` now exports:
- `bandedAlign`, `bandedAlignAscii`, `BandedAlignResult`
- `NanoporeEngine`, `NANOPORE_DEFAULT_SETTINGS`, `createTsScorer`, `resolveWtRois`
- All Nanopore types: `NanoporeSiteConfig`, `NanoporeRoundConfig`,
  `NanoporeSettings`, `NanoporeSiteStats`, `NanoporeRoundStats`,
  `NanoporeGlobalBreakdown`, `NanoporeOutcome`, `SiteScorerLike`,
  `DualAnchorSiteOutput`
- `runNanoporePipeline`, `NanoporePipelineRequest`, `NanoporePipelineProgress`,
  `NanoporePipelineResult`, `NanoporeSiteInput`, `NanoporeRoundInput`

Next: Phase 6.4 — `NanoporeAnalyzer` (per-site CSV + linked-haplotype CSV +
`Fitness_vs_WT_*` columns), then Phase 6.5 (worker discriminated union to
dispatch jobs to either pipeline).

## 2026-05-30 — Phase 6.2b — Rust port of banded alignment + DualAnchorScorer

Hot path lands in the WASM crate. The TS reference impl stays in place for
the Node-side test suite and as a fallback for environments without WASM;
both produce byte-identical results.

- Rust additions in [/web/packages/core-wasm/src/lib.rs](../../../../../../web/packages/core-wasm/src/lib.rs):
  - `banded_align(haystack, needle, max_subs, max_indels) → Option<MatchResult>`
    — port of the TS algorithm with identical tie-breaking semantics.
  - `limited_edit_distance` — Wagner-Fischer DP with row rolling + early
    termination at `tolerance = max_subs + max_indels`.
  - `bandedAlign` (free function, `#[wasm_bindgen]`) — returns a 4-element
    `Float64Array` `[found, start, end, score]`. Used by the parity test.
  - `DualAnchorScorer` struct exposing `addSite(fw, rv)`, `resultView()`,
    `score(seq)`. Per-site result layout: 5 `f64` slots per site —
    `[found, fwStart, fwEnd, rvStart, rvEnd]`. One WASM boundary crossing
    per read regardless of site count.
  - Downstream anchor is searched only from `fw_end` onward — the engine
    can't accidentally pair the upstream anchor with a downstream match
    that's actually before it.
- TS façade additions in [/web/packages/core/src/wasm.ts](../../../../../../web/packages/core/src/wasm.ts):
  - `createDualAnchorScorer(sites, maxSubs, maxIndels)` → `DualAnchorScorerLike`
  - `wasmBandedAlign(haystack, needle, maxSubs, maxIndels)` — one-shot wrapper
  - Both reuse the existing `resultView()`-aliasing trick (no per-call copy).
- Parity test [/web/packages/core/test/banded-align-parity.test.ts](../../../../../../web/packages/core/test/banded-align-parity.test.ts):
  - 10 fixed cases (exact match, sub/indel, edge cases) running both impls
    and asserting identical `{found, start, end, score}`.
  - 1 fuzz suite of 200 random anchor/haystack pairs × 5 (sub, indel) budgets
    = 1000 paired evaluations. All match.
- WASM bundle size: 18.4 KB → 23.7 KB (+5.3 KB for both new exports). Web
  build: 1,165 KB JS / 259 KB gz (unchanged — WASM is loaded separately).
- Test results: 101 passing (+11 new), 2 skipped (bench), 0 failing.
- Next: Phase 6.3 — wire `DualAnchorScorer` into a per-read `NanoporeEngine`
  with the QC funnel (read-Q → anchors → ROI-length → ROI-Q → translate →
  count) + the multi-site / haplotype accumulator.

## 2026-05-30 — Phase 6.2a — Banded approximate string matcher (TS reference impl)

First piece of the dual-anchor extraction engine. Pure-TS approximate string
matcher used to locate each site's upstream + downstream anchor in a Nanopore
read with tolerance for ~5% basecaller error.

- New file: [/web/packages/core/src/banded-align.ts](../../../../../../web/packages/core/src/banded-align.ts).
  - `bandedAlign(haystack, needle, maxSubs, maxIndels) → BandedAlignResult`
  - Wagner-Fischer DP with row rolling + early row-min termination at
    `tolerance = maxSubs + maxIndels`.
  - Window-length band: alignment span in `[m - maxIndels, m + maxIndels]`,
    so indel count is structurally capped.
  - Returns lowest-score hit; ties break by earliest start, then shortest length.
  - Tie-breaking rationale: prefer compact alignments, deterministic across
    runs, so the engine doesn't flap between equally-scoring placements.
- New test file: [/web/packages/core/test/banded-align.test.ts](../../../../../../web/packages/core/test/banded-align.test.ts)
  with 20 cases covering exact matches, substitutions, indels, combined
  errors, realistic 19-bp Nanopore anchors, edge cases (empty inputs,
  haystack too short, Uint8Array direct).
- `pnpm --filter @cdna/core test` → 90/92 passing (+20 new; 2 are skipped
  benches).
- Next: Rust port of the same algorithm + the `DualAnchorScorer` struct that
  uses it twice per site to locate the inter-anchor ROI (Phase 6.2b).

## 2026-05-30 — Phase 6.1e — Fix: blank page on Continue (Zustand v5 selector bug)

- Symptom: clicking Continue from Sources → Configure (or any step → step
  transition that mounted Configure/Preview) rendered a blank page.
- Root cause: `findAllSitesInReference` was being passed to
  `useNanoporeStore(...)` as a selector, but it returns a brand-new
  `{ ref, sites, refError, overlapError }` object on every call. Zustand v5
  enforces React 18's `useSyncExternalStore` contract that snapshot identity
  must be stable for unchanged state; an ever-changing snapshot trips the
  "getSnapshot should be cached" detection and React unmounts the tree.
- Fix: refactored `findAllSitesInReference` to a pure function taking
  `(inputSites, referenceSeq)` directly. ConfigureStep + PreviewStep now read
  the two relevant state slices via the store and wrap the call in `useMemo`,
  so the alignment object only recomputes when the inputs actually change.
- Added a docstring warning on the function so the trap isn't repeated.
- Files: [src/state/useNanoporeStore.ts](src/state/useNanoporeStore.ts),
  [steps/ConfigureStep.tsx](steps/ConfigureStep.tsx),
  [steps/PreviewStep.tsx](steps/PreviewStep.tsx).

## 2026-05-30 — Phase 6.1d — Multi-site redesign

Trigger: user pointed out that Nanopore SSM realistically has two saturated
sites that can sit 100–1000+ bp apart on the same amplicon. The original
"one shared anchor pair, one ROI" model can't represent that.

Changes:
- Store: replaced shared `fwAnchor` / `rvAnchor` (top-level) with
  `sites: NanoporeSite[]`, each holding `{name, fwAnchor, rvAnchor}`. Default
  is 1 site (single-codon SSM); users add more for distant variable positions.
- Store: added `reportHaplotype: boolean`, default true. Only meaningful when
  ≥2 sites are configured.
- Store: replaced `findAnchorsInReference` (single-site) with
  `findAllSitesInReference` (per-site + overlap check). Each site's anchors
  must be locatable in the reference, in order; sites cannot overlap.
- Configure step: "Shared anchors" card replaced with **Variable sites**
  card. Each site is a card-within-card with name + fw/rv anchor inputs +
  live ROI-length feedback derived from the reference.
- Configure step: new **Output** card with two rows:
  - "Per-site enrichment" — always emitted
  - "Linked haplotype counts" — checkbox, auto-gated by `sites.length >= 2`,
    with `needs ≥2 sites` badge until then.
- Preview step: numbered marker line above the reference ruler so multi-site
  cases are visually trackable. Each site's anchors paint primary, each ROI
  paints success. Per-site status grid below the ruler (green check / amber
  warn). Continue gated on all-sites-aligned + no-overlap.
- Run step: summary line shows `N sites + haplotype` when applicable.
- Results step: per-round yield table grew a "passed per site" column per
  site; variant tables became tabbed (one tab per site, plus a `haplotype`
  tab when ≥2 sites enable linkage).
- Plan file: Phase 6.4 analyzer scope updated to emit two CSV families:
  `enrichment_per_site.csv` (long format) + `enrichment_haplotype.csv`
  (joined-codon haplotypes, only when all sites extract from same read).
  Stats schema bumped to `schema_version: 2` with `sites.{site}.{counter}`
  nested per round.

## 2026-05-30 — Phase 6.1c — Wire real state into UI

- Replaced mockup placeholders with real state-backed inputs across all 5
  steps (Sources, Configure, Preview, Run; Results stays placeholder until
  the engine ships).
- Multiplexed mode wires shared local + Drive FASTQ picker (drag-drop,
  multi-select, file warnings). Per-round mode wires per-round file picker
  on Configure (local + Drive, sign-in via Sources).
- Per-round form: name + (multiplexed) barcode 3–12 bp prefix + (per-round)
  FASTQ file/Drive ref.
- Continue / Back wired to `goNext` / `goPrev`. Each step has validation
  selectors that disable Continue when the form is incomplete:
  - Sources: project name required; multiplexed also requires ≥1 file
  - Configure: reference ≥30 bp; both anchors ≥12 bp; all rounds named; all
    rounds have barcode (multiplexed) or file (per-round); unique barcodes
- Advanced QC defaults baked in: read Q≥10, ROI Q≥15 (SUP R10.4 baseline).
- Extracted `isDriveSignedIn()` into [adapters/DriveAuthProvider.ts](../../../adapters/DriveAuthProvider.ts)
  as a shared export so both tools use the same Drive token check.

## 2026-05-30 — Phase 6.1b — 5-step pseudo UI skeleton

- Built `SourcesStep`, `ConfigureStep`, `PreviewStep`, `RunStep`,
  `ResultsStep` as visual mockups mirroring the cDNA tool's layout. Lots of
  primary-tinted elements per step so the indigo theme is unmistakable when
  the user clicks the Nanopore pill in the header.
- Added `useNanoporeStore.ts` with step navigation (`currentStep`, `goNext`,
  `goPrev`, `setStep`).
- Removed the old single-step `ComingSoonStep`; the tool now exposes 5 step
  ids (sources / configure / preview / run / results).
- Shared "UI preview — inputs inert" banner so it's clear nothing was wired
  yet at this stage.

## 2026-05-30 — Phase 6.1 — Per-tool theming infrastructure

- Added `:root[data-tool="nanopore-ssm"]` CSS variable override in
  [src/index.css](../../../index.css): primary + ring + secondary + accent
  flip to indigo (`hsl(243 75% 59%)`); semantic colors (success / warning /
  destructive) stay shared with cDNA so a yellow warning means the same thing
  in both tools.
- App.tsx mirrors `activeToolId` onto `<html data-tool="...">` via a
  `useEffect`, so all charts/UI auto-pick the per-tool palette.
- Refactored `RankAbundance.tsx` (cDNA viz) to source `PALETTE[0]` from
  `hsl(var(--primary))` so the first-round line follows the active theme.
- Created the test fixture at [00_material/test_nanopore/](../../../../../../00_material/test_nanopore/)
  with a seeded generator (1k reads across 3 rounds + ground-truth metadata
  + intentional bad-read mix across 9 failure modes).
