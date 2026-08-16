# Paper release freeze checklist

No paper tag is created by this checklist until every required gate is green.
Development profiling is explicitly non-publication evidence.

## Current freeze-candidate status (2026-08-16)

Completed in the working tree:

- Core: 242 tests passed; 2 formal benchmark tests remain intentionally skipped.
- Web: 83 tests passed; targeted CLI: 2 tests passed; workspace typecheck and
  production build passed.
- Chromium, Firefox and WebKit: 12/12 E2E checks passed across 10k gzip
  multi-shard analysis, cancel/rerun, module isolation and browser capability
  capture.
- Targeted WASM correctness and development speed/RSS gate passed; see
  `TARGETED_WASM_GATE.md`.
- Production cDNA analysis uses dense columns and a stable sort index; its CSV
  is byte-identical to the public row-based reference API on parity fixtures.
- Drive source unit coverage confirms that every `open()` obtains a fresh
  token. The manifest generator streams files and production assets into
  SHA-256 without loading them into memory.

Still blocking a paper tag:

- Chromium cDNA 12.20 GB and deterministic Nanopore >10 GB soak runs.
- Firefox and WebKit approximately 1 GB soak runs.
- Authenticated Google Drive medium multi-file/token-renewal run.
- Archive of final full-file data hashes, machine/browser inventory, SBOM,
  defaults and Methods evidence after the soak gates pass.

## Immutable inputs

- Build the production app and run the complete unit/parity/E2E suites.
- Generate full-file SHA-256 for every benchmark input, locks, WASM binary and
  production asset with `pnpm paper:manifest -- <data paths...>`.
- Save `pnpm licenses list --json` as the dependency/SBOM evidence and record
  OS, CPU, RAM, browser versions and Playwright version.
- Archive the locked configs, default parameter table and generated Methods
  text beside the manifest.

## Required gates

- cDNA: TS/WASM/Python parity; gzip/plain parity; whole/sharded/reordered
  parity; malformed, empty, cancellation and zero-coverage behavior.
- Targeted Nanopore: TS/WASM orientation, CIGAR, QC, calls and complete output
  hashes; candidate speed-up >=1.5x median of three and peak RSS <=110% of TS.
- Chromium/Firefox/WebKit: 10k full E2E plus gzip, multi-shard, cancel/rerun.
- Chromium: cDNA 12.20 GB and Nanopore >10 GB soak. Firefox/WebKit: >=1 GB.
- Google Drive: refreshed token on each file open and a medium multi-file run.

## Release rule

Only after the evidence above is archived should versions be changed to
`v1.0.0-paper`, locks and asset hashes committed, and an annotated Git tag and
source archive created. Any implementation/default/schema fix after that point
requires `v1.0.0-paper.2` and rerunning every affected benchmark unit.
