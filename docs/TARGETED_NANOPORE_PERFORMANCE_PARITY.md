# Targeted Nanopore performance and bit-parity audit

Date: 2026-07-14

## Scope

The run-scoped reference seed index, selected-strand offset reuse, packed
band traceback, and allocation-free DP maximum selection were compared with
commit `d83a3ce` using the inferred 1,155-bp MTG reference and 12 targets.

Inputs:

- `260707-MTG-Original.fastqsanger`: 33,148 reads
- `260707-MTG-Selected.fastqsanger`: 19,918 reads
- Total: 53,066 reads

The same configuration, thresholds, input order, and CLI build mode were used
for both runs.

## Bit-level verification

The complete pipeline JSON from the baseline and optimized builds was compared
with both SHA-256 and `cmp`.

```text
baseline  76ce1103711f9669084d60779449749b60c68d14fddffd67383a1476707aaba5
optimized 76ce1103711f9669084d60779449749b60c68d14fddffd67383a1476707aaba5
cmp       identical
```

An additional 2,000-read record-level audit serialized orientation, alignment
score, read start/end, match/mismatch/insert/delete counts, identity, reference
coverage, CIGAR, estimated offset, seed hits, band used, band-edge status, and
failure classification. Both files had this SHA-256:

```text
dc1be750415a2030e54ae6f8b0d78475c49d98b4f8c86e7fdb4c914d9374a24c
```

The 2,000-read aggregate pipeline output also matched byte-for-byte:

```text
b3305f4056f3c0574647f4bfe4dcb6ccabc60641769fc580c8138b7b4a192795
```

## Performance

Measured with `/usr/bin/time` on the same host:

| Run | Wall time | Throughput | Peak RSS |
|---|---:|---:|---:|
| Baseline | 308.78 s | 171.9 reads/s | 333,156 KB |
| Optimized | 123.68 s | 429.1 reads/s | 325,832 KB |

The full-run speed-up was 2.50x. On the 2,000-read sample, runtime changed from
10.22 s to 4.28-4.32 s (2.37-2.39x), and peak RSS fell from 191,572 KB to
109,756-143,124 KB. Full-run peak RSS is dominated by retained read-ID and
count maps, so traceback compaction has a larger effect on short-run peak RSS
than on the final full-run peak.

## Invariants

The optimization does not change scoring parameters, M/I/D states, deterministic
tie order (`M > I > D`), band widening thresholds, traceback rules, CIGAR
construction, QC thresholds, target projection, counting, or statistics.
Only repeated reference-side work, temporary allocation layout, and equivalent
scalar maximum selection were changed.
