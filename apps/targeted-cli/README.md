# Targeted Nanopore local CLI

This is the local, auditable entry point for the full-amplicon targeted sibling
pipeline. It does not replace the existing fixed-ROI SSM pipeline.

The configuration file is mandatory. In particular, target coordinates are never
inferred from noisy mutation peaks.

```yaml
schemaVersion: 1
reference:
  crispressoJson: ../../path/to/CRISPResso2_info.json
sites:
  - name: site_01
    ntStart: 101       # 1-based reference coordinate
    length: 3
rounds:
  - name: original
    role: input
    fastq: ../../path/to/original.fastq
  - name: selected
    role: selected
    fastq: ../../path/to/selected.fastq
qc:
  minReadQ: 10
  minAlignmentIdentity: 0.85
  minReferenceCoverage: 0.90
  minProtectedIdentity: 0.95
  maxProtectedIndelBases: 0
```

From the `web` directory:

```sh
pnpm --filter @cdna/targeted-cli build
node apps/targeted-cli/dist/main.js validate --config config.yaml
node apps/targeted-cli/dist/main.js q-audit --config config.yaml --limit 500
node apps/targeted-cli/dist/main.js benchmark --config config.yaml --limit 500
node apps/targeted-cli/dist/main.js analyze --config config.yaml --limit 5000
```

`q-audit` reports Dorado's `qs:f` header score separately from a score
recalculated using Dorado's error-probability definition. `benchmark` is an
early performance and alignment-funnel check. `analyze` invokes the same
production counting/statistics core as the Web Worker; `--limit` caps reads per
source for a reproducible smoke test.
