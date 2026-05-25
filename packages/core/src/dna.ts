// Standard genetic code. Byte-for-byte identical to the table duplicated in
// 01_scripts/core_engine.py and 01_scripts/analysis_engine.py. Kept here as
// the single source of truth for the TS port.
export const CODON_TABLE: Readonly<Record<string, string>> = Object.freeze({
  ATA: "I", ATC: "I", ATT: "I", ATG: "M", ACA: "T", ACC: "T", ACG: "T", ACT: "T",
  AAC: "N", AAT: "N", AAA: "K", AAG: "K", AGC: "S", AGT: "S", AGA: "R", AGG: "R",
  CTA: "L", CTC: "L", CTG: "L", CTT: "L", CCA: "P", CCC: "P", CCG: "P", CCT: "P",
  CAC: "H", CAT: "H", CAA: "Q", CAG: "Q", CGA: "R", CGC: "R", CGG: "R", CGT: "R",
  GTA: "V", GTC: "V", GTG: "V", GTT: "V", GCA: "A", GCC: "A", GCG: "A", GCT: "A",
  GAC: "D", GAT: "D", GAA: "E", GAG: "E", GGA: "G", GGC: "G", GGG: "G", GGT: "G",
  TCA: "S", TCC: "S", TCG: "S", TCT: "S", TTC: "F", TTT: "F", TTA: "L", TTG: "L",
  TAC: "Y", TAT: "Y", TAA: "*", TAG: "*", TGC: "C", TGT: "C", TGA: "*", TGG: "W",
});

// ASCII byte codes used throughout the byte-first hot path.
export const ASCII = Object.freeze({
  A: 0x41, C: 0x43, G: 0x47, T: 0x54, N: 0x4e,
  a: 0x61, c: 0x63, g: 0x67, t: 0x74, n: 0x6e,
  NEWLINE: 0x0a,
});

const LATIN1 = new TextDecoder("latin1");

// Reverse-complement bytes → fresh, atomized string. The returned string is
// produced through TextDecoder so it carries no parent-buffer reference and
// is safe to use as a Map key (no V8 sliced-string retention).
export function reverseComplementBytes(input: Uint8Array): string {
  const n = input.length;
  const out = new Uint8Array(n);
  for (let i = 0; i < n; i++) {
    const c = input[n - 1 - i];
    // Uppercase ACGTN only; anything else passes through (matches Python's
    // str.translate behavior, which leaves untranslated chars unchanged).
    out[i] = c === ASCII.A ? ASCII.T
           : c === ASCII.T ? ASCII.A
           : c === ASCII.C ? ASCII.G
           : c === ASCII.G ? ASCII.C
           : c === ASCII.N ? ASCII.N
           : c;
  }
  return LATIN1.decode(out);
}

// String-level RC, used by preview/analysis code paths where we already hold
// a string. Mirrors Python's `seq.translate(str.maketrans('ATCGN','TAGCN'))[::-1]`.
export function reverseComplement(seq: string): string {
  const n = seq.length;
  const bytes = new Uint8Array(n);
  for (let i = 0; i < n; i++) bytes[i] = seq.charCodeAt(i);
  return reverseComplementBytes(bytes);
}

// Translation. Matches Python's range(0, len(seq), 3) semantics: a trailing
// 1- or 2-character partial codon at the end is looked up in the table and
// falls through to 'X', identical to the Python lookup with default 'X'.
export function translateDna(seq: string): string {
  let out = "";
  for (let i = 0; i < seq.length; i += 3) {
    const codon = seq.substring(i, i + 3);
    out += CODON_TABLE[codon] ?? "X";
  }
  return out;
}

// GC% in [0, 100]. Matches Python:
//   ((seq.count('G') + seq.count('C')) / len(seq)) * 100.0
// Only uppercase ACGT counted, consistent with the demultiplex pipeline which
// stores uppercase DNA in dna_counters.
export function calculateGc(seq: string): number {
  const n = seq.length;
  if (n === 0) return 0.0;
  let gc = 0;
  for (let i = 0; i < n; i++) {
    const c = seq.charCodeAt(i);
    if (c === ASCII.G || c === ASCII.C) gc++;
  }
  return (gc / n) * 100.0;
}

// Returns true iff translating the CDS bytes would produce no '*' stop codon.
// The three stop codons are TAA, TAG, TGA — all begin with 'T', so we can
// short-circuit on first-base mismatch and avoid touching the table.
// Codons containing 'N' (or any other letter) cannot match a stop signature
// (their first base is not 'T' for the stop set), so they pass through
// correctly even though translateDna would map them to 'X'.
export function hasNoStopCodon(dnaBytes: Uint8Array): boolean {
  const n = dnaBytes.length;
  for (let i = 0; i + 3 <= n; i += 3) {
    if (dnaBytes[i] !== ASCII.T) continue;
    const b = dnaBytes[i + 1];
    const c = dnaBytes[i + 2];
    if (b === ASCII.A && (c === ASCII.A || c === ASCII.G)) return false; // TAA, TAG
    if (b === ASCII.G && c === ASCII.A) return false;                     // TGA
  }
  return true;
}

// Decode CDS bytes into a fresh, atomized string suitable for Map keys.
// Using TextDecoder breaks any parent-buffer reference and avoids V8's
// sliced-string retention that would otherwise pin the source FASTQ chunk
// in memory for the lifetime of the Map entry.
export function decodeCds(cdsBytes: Uint8Array): string {
  return LATIN1.decode(cdsBytes);
}
