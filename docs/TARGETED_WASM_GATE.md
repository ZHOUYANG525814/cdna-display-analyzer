# Targeted full-alignment WASM gate

Date: 2026-08-16. These are development/freeze checks, not paper benchmark
results.

## Correctness

- 200 deterministic synthetic reads with substitutions, insertions, deletions
  and terminal flanks: every alignment field and CIGAR matched TypeScript.
- First 2,000 real MTG reads, both orientations: 4,000 alignment records were
  field-identical.
- Complete 53,066-read Original/Selected pipeline: TypeScript and WASM emitted
  identical hashes:

| Artifact | SHA-256 |
|---|---|
| Complete canonical pipeline result | `abd6f42e7366e988edb77b564d4b1202a4cd6f632c402ab2a089b286583c66c2` |
| Per-site CSV | `d9d2fec6885cf3ea070ef51f15140e28eae1bae1ae68083d3a54afbc2bf2e41d` |
| Haplotype CSV | `074144c329d6365c866b78cb1b08a84ebb8ad497d707f374c3cc9f858aaf94f3` |
| Exact-codon CSV | `622bf1e6a43d30d752df85005990e83ab00c979a278a3928f258cee01236488a` |
| Exact-haplotype CSV | `ee0455326ce9c87a233020fe3af58779dafb50b213e50fc0a1254d1eefc145e0` |

## Development performance gate

The same 2,000-read request was run three times per engine:

| Engine | Wall times (s) | Median (s) | Peak RSS range (KB) |
|---|---:|---:|---:|
| TypeScript | 15.08, 15.12, 15.63 | 15.12 | 117,328–122,096 |
| WASM | 8.34, 8.34, 8.34 | 8.34 | 68,792–70,540 |

Median speed-up was 1.81x and RSS did not increase. The full 53,066-read
verification took 218.64 s / 245,736 KB in TypeScript and 119.36 s / 83,776 KB
in WASM (1.83x). The production targeted Worker therefore enables the isolated
WASM aligner; TypeScript remains the truth implementation and CLI fallback.

## Bundle isolation

The cDNA scorer and targeted aligner are compiled as separate feature builds
and published as separate workspace packages. Production output contains a
23.71 KB cDNA WASM asset and a 34.40 KB targeted WASM asset. Playwright asserts
that initializing one tool does not request the other tool's Worker.
