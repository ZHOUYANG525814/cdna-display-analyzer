# Nanopore MTG initialization audit

Date: 2026-07-13

## Executive decision

The web application already contains a complete Nanopore SSM pipeline. It is
not an empty scaffold. Keep that pipeline for one- or two-site, fixed-length
SSM experiments, but do not use it unchanged for the MTG scanning library.

The MTG data is a full 1,155 bp amplicon scanning experiment. Its useful signal
is distributed by reference position, while the current SSM engine extracts a
small, fixed-length ROI between a separately configured pair of anchors. The
next implementation should therefore add a scanning analysis mode beside the
existing SSM mode and reuse the browser shell, file adapters, Worker transport,
export code, and shared statistics.

## Current web architecture

```text
apps/web
  App + tool registry
    cdna-display wizard       nanopore-ssm wizard
             |                       |
             +---- Zustand stores ---+
                         |
                  Comlink Web Worker
                         |
packages/core
  FASTQ stream -> pipeline orchestrator -> engine -> analyzer -> CSV parts
                         |
packages/core-wasm
  hot-path anchor scoring and reverse-complement operations
```

The Nanopore path is already wired end to end:

- `apps/web/src/tools/nanopore-ssm`: five real wizard steps, demo loading,
  local/Drive sources, configuration, preview, run, and results/download UI.
- `apps/web/src/state/useNanoporeStore.ts`: independent navigation,
  configuration, run progress, logs, and output state.
- `apps/web/src/worker/pipeline.worker.ts`: `runNanopore` Worker RPC route.
- `packages/core/src/nanopore.ts`: read-Q gating, per-round binding, dual-anchor
  extraction, ROI-Q/length/stop filters, counters, and linked haplotypes.
- `packages/core/src/nanopore-pipeline.ts`: streaming orchestration, reverse-
  complement retry, logging, analyzer dispatch, and run statistics.
- `packages/core/src/nanopore-analyzer.ts`: DNA-to-AA aggregation, RPM,
  WT-relative fitness, centered fitness, variance, z/p values, BH FDR, and CSV.

Baseline verification on 2026-07-13:

- all workspace TypeScript type checks pass;
- core: 148 tests pass, 2 benchmark tests are intentionally skipped;
- web: 7 tests pass;
- the Nanopore tests include single-site, two-site, haplotype, analyzer, and
  complete streaming-pipeline coverage on synthetic fixtures.

## Real MTG inputs inspected

Reference inputs:

- `260707-MTG-Original.fastqsanger`: 33,148 FASTQ records, 84,422,278 bytes;
- `260707-MTG-Selected.fastqsanger`: 19,918 FASTQ records, 47,230,297 bytes.

The files are valid four-line, uncompressed FASTQ despite the `.fastqsanger`
suffix. The browser's local-file adapter can stream them without a format
conversion.

Read-length summary:

| Dataset | P10 | Median | P90 | Maximum |
|---|---:|---:|---:|---:|
| Original | 397 bp | 1,224 bp | 1,240 bp | 41,373 bp |
| Selected | 295 bp | 1,222 bp | 1,238 bp | 41,373 bp |

The matching CRISPResso2 reports define a 1,155 bp MTG amplicon and report:

| Dataset | Input | Aligned | Alignment rate |
|---|---:|---:|---:|
| Original | 18,901 | 18,786 | 99.39% |
| Selected | 10,100 | 10,050 | 99.50% |

The raw FASTQ record counts are larger than the CRISPResso input counts, so
CRISPResso preprocessing applied an additional inclusion rule. A new scanner
must make its own completeness/orientation filters explicit and report them in
the QC funnel rather than assuming every raw record is a usable amplicon.

The existing CRISPResso nucleotide tables also show that the experiment cannot
be reduced to one small ROI. In Original, 67 reference positions have more
than 5% non-reference base frequency (31 positions exceed 10%). Large
Original-to-Selected changes cluster at multiple regions, including amino-acid
positions 304-308, while other sites increase after selection (for example
around amino-acid positions 116-117 and 339). This is position-wise scanning
signal across the amplicon.

## Why the existing SSM engine is not the MTG scanner

The SSM engine assumes:

1. each site has a short upstream and downstream anchor;
2. the sequence strictly between those anchors is the only variable ROI;
3. the observed ROI length must exactly equal the WT ROI length;
4. the ROI translates independently and can be counted as one variant;
5. a small configured list of sites is scanned independently per read.

Those assumptions are appropriate for the included one- and two-site fixtures.
They are not appropriate for hundreds of codons across a 1,155 bp reference.
Registering every codon as an SSM site would repeatedly scan every full read
for hundreds of anchor pairs, lose a coherent full-read alignment, and make
basecaller indels difficult to distinguish from biological changes.

Two additional caveats should be handled in the scanner design:

- Current `meanPhred` is the arithmetic mean of per-base Phred values because
  it preserves parity with the older cDNA implementation. Dorado's `qs:f`
  read tag is much lower than that arithmetic mean on these files. The scanner
  should define whether it uses the tag, arithmetic mean Q, or the error-
  probability-derived mean Q and expose that choice in QC.
- Reads include short/incomplete molecules and rare concatenated reads up to
  41 kb. Full-amplicon completeness and multi-copy/chimera rejection need
  dedicated discard buckets.

## Recommended scanning-mode boundary

Add a sibling core path rather than rewriting `nanopore.ts`:

```text
nanopore-scanning-pipeline.ts
  stream + orientation + full-amplicon eligibility
        -> full-reference banded alignment (WASM hot path)
        -> per-read event projection onto reference coordinates
        -> per-position / per-codon accumulator
        -> Original-vs-Selected scanning analyzer
```

Reuse unchanged:

- `IFastqSource`, local/Drive adapters, streaming FASTQ parser;
- Worker execution, progress/log transport, cancellation pattern;
- Blob/CSV-parts export strategy;
- statistical helpers and BH correction;
- common UI cards and the existing tool registry.

Keep separate:

- full-amplicon aligner and alignment QC;
- reference-position event representation;
- scanning counts and error-background model;
- position/codon heatmaps and scanning-specific CSV schema.

Suggested first output contract:

- `position_counts.csv`: reference coordinate, WT base/codon, A/C/G/T/deletion
  counts and frequencies per round;
- `codon_effects.csv`: reference codon/AA, observed codon/AA, counts, RPM,
  Original-to-Selected log2 enrichment, variance, p value, and BH FDR;
- `run_stats.json`: raw, complete-amplicon, aligned, orientation-flipped,
  short/incomplete, concat/chimera, low-Q, and accepted counts;
- `QC_Summary_Report.txt`: reference hash/length, thresholds, filter funnel,
  and method definitions.

## Implementation order

1. Freeze the MTG reference and preprocessing contract from the CRISPResso
   metadata; reproduce its 18,901/10,100 input decision or document a better
   explicit rule.
2. Add a small deterministic fixture cut from/simulating the 1,155 bp MTG
   amplicon with substitutions, one-base indels, reverse-complement reads,
   truncations, and a concat read.
3. Implement and parity-test one full-reference alignment/event projection in
   TypeScript, then port only the measured hot loop to WASM.
4. Add position/codon accumulation and Original-vs-Selected statistics.
5. Wire the scanning mode into the existing Nanopore wizard and validate on
   the two supplied `.fastqsanger` files before adding visualizations.

