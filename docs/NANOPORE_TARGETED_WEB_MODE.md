# Nanopore targeted NNK Web mode

## Scope

The former fixed-ROI SSM and Targeted NP user entries are consolidated into a
single **Nanopore** window. Its full-amplicon path covers both 1–2-codon SSM
and multi-codon scanning libraries, and reuses the existing FASTQ adapters, Google
Drive OAuth/Picker, Web Worker transport, statistical helpers and CSV model.

The biological model is deliberately narrow: consecutive selection rounds
named `Round 0`, `Round 1`, …; Round 0 is always the baseline. Each round may
contain one or many FASTQs. Multiple files are technical shards, not
replicates, and duplicate read IDs within a round are counted once.

## Four-step workflow

1. **Inputs** — project; FASTQs per round (local or Drive); full amplicon;
   forward-orientation CDS interval; target codons selected by clicking the AA
   track or typing AA/explicit `nt:` coordinates.
2. **QC** — four visible controls: read Q, protected identity, target base Q,
   and minimum Round-0 count. The user locks the configuration.
3. **Run** — FASTQ/.gz streams are parsed in a Worker; one affine-gap
   full-reference alignment drives all calls.
4. **Results** — whole-read funnel, per-site callability/rescue, enrichment,
   optional target-only haplotypes, CSV and audit JSON.

## QC and rescue semantics

- Prefer Dorado `qs:f`; otherwise recalculate ONT mean Q from mean error
  probability (not arithmetic base-Q mean).
- Mask all target codons from protected-reference identity.
- Reads at least 1.5× reference length are classified as concatemer/chimera
  candidates before semiglobal alignment and cannot be rescued.
- Isolated protected substitutions and small indels do not automatically
  discard a read. CIGAR projection preserves downstream coordinates.
- A target-overlapping insertion/deletion makes only that site uncallable.
- A partial read may contribute to a site when the complete high-Q codon and
  30 real read bases on each side are present and the local protected identity
  passes. Deletions do not count as flank coverage.
- Rescued calls enter the corresponding site denominator but never a linked
  haplotype.
- All complete high-Q codons are counted. NNK compatibility is a QC annotation,
  never an enrichment exclusion; stop codons remain visible.

## Statistics

For every `Round n` (`n > 0`), the analyzer reports WT-normalized log2 fitness
against Round 0 with pseudocount 1.0, eligible-library median centering,
four-term Poisson delta variance, Z, two-sided p, and BH-FDR scoped within each
site. Variants below the minimum Round-0 count keep counts/fitness but have
blank inferential fields and do not influence the centering median or BH family.

Without biological replicates, uncertainty is count-derived and understates
total experimental uncertainty; the Results page states this explicitly.

## Streaming and outputs

Drive uses `files.get?alt=media` and consumes `response.body` directly. Local
files use `File.stream()`. `.fastq.gz`/`.fq.gz` are decompressed with a
backpressure-preserving `DecompressionStream`; raw sequence is not uploaded or
buffered as a complete file.

Accepted input suffixes are `.fastq`, `.fq`, `.fastqsanger` and the gzip form
of each. Local inputs must pass a decompressed first-record check before they
enter the form. The production parser then validates every record, reports
malformed records, and resynchronizes at the next FASTQ header. Rounds, files,
reference length and site count have explicit pressure limits.

The Inputs screen includes a deterministic three-round Demo. It exercises two
sites, linked haplotypes, reverse reads, a multi-file round, low-Q, partial-read
rescue, concatemer rejection and `.fastqsanger` ingestion through the same
production core.

Downloads:

- per-site enrichment CSV;
- optional target-only haplotype CSV;
- QC/provenance JSON containing locked settings, sites, per-file funnels,
  per-round funnels, callability and centering medians.

## Verification

Core tests cover forward/reverse reads, multiple shards, duplicate IDs,
concatemer rejection, partial site rescue, haplotype exclusion and Round-0
fitness. The MTG Original/Selected files are also exercised through the same
production core via the local `targeted-nanopore analyze` command.
