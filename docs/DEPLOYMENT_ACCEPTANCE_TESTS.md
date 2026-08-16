# Deployment acceptance tests

Use this matrix after a GitHub/Vercel deployment. These checks validate a
freeze candidate; timings collected here are diagnostic and must not be used
as paper benchmark results.

For every successful run, retain the locked config, `run_stats.json`, all CSV
files, browser/version, input byte sizes and the browser console log. Generate
full input SHA-256 separately before a formal freeze.

## 0. Deployment smoke tests

| ID | Browser | Input | Expected result |
|---|---|---|---|
| SMOKE-NGS | Chromium | Built-in NGS demo | Results page opens; 10,000 total reads; downloads open. |
| SMOKE-NP | Chromium | Built-in Nanopore demo | Both rounds and all configured targets produce results; four CSV downloads open. |
| ISOLATION-NGS | Chromium DevTools, Disable cache | Open NGS only | No `targeted-nanopore.worker` or targeted WASM request. |
| ISOLATION-NP | Chromium DevTools, Disable cache | Open Nanopore only | No `cdna.worker` or cDNA scorer WASM request. |

## 1. NGS: one multiplexed dataset, rounds distinguished by tags

This is the normal small-library mode. Select **Multiplexed/barcoded**.

| ID | Input construction | Expected result |
|---|---|---|
| NGS-MX-01 | One FASTQ containing reads from Round 0, 1 and 2, each with a distinct forward-primer/barcode | Reads distribute to all three rounds; unassigned breakdown is reported. |
| NGS-MX-02 | Same content split into 2–8 technical FASTQ shards | Scientific CSV is identical to NGS-MX-01. |
| NGS-MX-03 | Reverse the shard selection order | Scientific CSV is identical; only provenance file order may differ. |
| NGS-MX-04 | gzip every shard | Result is identical to uncompressed input; progress shows reads and compressed bytes without a false decompressed total. |
| NGS-MX-05 | Add reads with unknown tag, one-base barcode error and an ambiguous tie | Exact/one-error assignments follow the locked rules; ambiguous and unmatched reads appear in QC buckets. |

Minimum practical sizes: 1k, 10k and 100k reads. Repeat NGS-MX-02 at 1M
reads before the multi-GB soak.

## 2. NGS: one dataset per biological round

This is the normal large-library mode. Select **Per-round**. The same primer is
allowed in different rounds because files provide the biological assignment.

| ID | Input construction | Expected result |
|---|---|---|
| NGS-PR-01 | Round 0, 1 and 2 each receive one FASTQ | Each file is processed only against its bound round. |
| NGS-PR-02 | Each round receives 2–4 shards, mixing `.fastq`, `.fq.gz` and `.fastq.gz` | Shards merge within each round and the run completes. |
| NGS-PR-03 | Concatenate each round's shards offline and rerun as one file per round | CSV is byte-identical to NGS-PR-02. |
| NGS-PR-04 | Reverse shard order within each round | Counts, dominant DNA and enrichment remain identical. |
| NGS-PR-05 | Bind one file to the wrong round intentionally | Preflight assignment/QC should look abnormal; cancel without changing parameters, correct the binding and rerun. |

Scale progression: 10k → 100k → 1M reads → approximately 1 GB → the
existing 12.20 GB BEFORE/AFTER Chromium soak.

## 3. Nanopore: separate files for separate rounds

This is the primary supported Nanopore input contract. Round 0 is the baseline;
Round 1 and later are selected libraries. Each round may have multiple
technical shards.

| ID | Input construction | Expected result |
|---|---|---|
| NP-RD-01 | Round 0 and Round 1, one FASTQ each, one target codon | Orientation, full-length QC and the target call complete; enrichment is relative to Round 0. |
| NP-RD-02 | Round 0–3 with one file per round and 2–10 target codons | Every site has per-round counts; linked haplotypes are emitted when enabled. |
| NP-RD-03 | Split each round into 2–4 shards | Final JSON/CSV hashes match the corresponding concatenated files. |
| NP-RD-04 | Reverse shard order and include duplicate read IDs across two shards in one round | The first occurrence in locked file order wins; duplicate counts are reported. Scientific output is deterministic for a fixed order. |
| NP-RD-05 | Mix forward and reverse-complement reads | Calls match after orientation normalization. |

## 4. Nanopore: multiple NNK target sites in the same amplicon

The current tool supports multiple researcher-defined codons in every read.
Use this for amplicons that mix several single-site NNK libraries. It still
requires a Round 0 baseline plus at least one selected round; a true one-round
counts-only project is not yet supported.

| ID | Input construction | Expected result |
|---|---|---|
| NP-MS-01 | Two rounds; reads carry mutations at one of 3–10 configured target codons | Per-site exact codon and amino-acid counts are correct; non-mutated sites remain WT. |
| NP-MS-02 | Include reads mutated at two configured sites | Per-site calls and the linked haplotype both represent the read. |
| NP-MS-03 | Insertion/deletion exactly inside a target codon | Target is classified as indel/non-callable according to QC; it is not silently converted to a substitution. |
| NP-MS-04 | Indel outside target but inside protected reference | Global QC or local rescue follows the locked thresholds and is reported. |
| NP-MS-05 | Partial reads, concatemer-length reads, low-Q reads and truncated FASTQ records | Each enters an explicit QC/error bucket; the run does not silently count it as WT. |

## 5. Nanopore mixed/barcoded rounds

One FASTQ containing several Nanopore rounds distinguished by tags is **not a
supported production mode in this freeze candidate**. Do not use the NGS
demultiplexer for these reads. For current testing, demultiplex upstream with a
locked, documented command and provide the resulting per-round FASTQs to the
Targeted Nanopore tool.

A future native mode needs its own tag orientation/error model, ambiguous-tag
policy, per-tag truth fixtures and parity tests before it can enter the paper
version.

## 6. Required negative and recovery cases

Run these on both tools where applicable:

- empty FASTQ;
- malformed header or missing quality line;
- sequence/quality length mismatch;
- truncated gzip;
- duplicate local `File` object or duplicate Drive ID;
- probable duplicate detected by size plus sampled head/tail hash;
- missing round, duplicate round name or conflicting binding;
- zero passed-QC coverage;
- cancel during preflight, cancel during analysis, then rerun;
- leave the tool and return, confirming the previous Worker was released;
- download all artifacts, then start a new run and confirm old results are gone.

## 7. Browser and scale matrix before tagging

| Browser | Required functional run | Required soak |
|---|---|---|
| Chromium | All smoke, gzip, multi-shard and cancel/rerun cases | cDNA 12.20 GB and Nanopore >10 GB |
| Firefox | 10k gzip multi-shard for both supported pipelines | Approximately 1 GB |
| WebKit | 10k gzip multi-shard for both supported pipelines | Approximately 1 GB |

Google Drive additionally requires one authenticated medium multi-file run
that lasts long enough to verify a refreshed token on every file open.

## 8. Additional recommended biological cases

- A no-selection control where Round 0 and Round 1 are sampled from the same
  library; centered enrichment should remain near zero overall.
- A spike-in panel with known WT and known enriched/depleted variants spanning
  low, medium and high input abundance.
- High-diversity libraries where most variants occur once, stressing unique
  variant growth and CSV size rather than only read throughput.
- Strong bottleneck selection where most Round 0 variants disappear, used to
  inspect the recorded library median before interpreting centered enrichment.
- Nanopore reads containing homopolymers and target-adjacent indels, which are
  common failure modes for alignment and local rescue.
- A hold-out experimental batch generated on a different sequencing date or
  flow cell. Do not use it while tuning thresholds; reserve it for independent
  validation after parameters are locked.
