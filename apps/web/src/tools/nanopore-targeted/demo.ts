import type { TargetedRoundForm, TargetedSiteForm } from "@/state/useTargetedNanoporeStore";

const DNA = "ACGT";
function makeReference(): string {
  let state = 0x5eed1234;
  let out = "";
  for (let i = 0; i < 540; i++) {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    out += DNA[(state >>> 24) & 3]!;
  }
  return replaceCodon(replaceCodon(out, 61, "GCT"), 451, "TAC");
}
export const NANOPORE_DEMO_REFERENCE = makeReference();
export const NANOPORE_DEMO_SITES: TargetedSiteForm[] = [
  { id: "demo_site_1", name: "site_01", ntStart: 61 },
  { id: "demo_site_2", name: "site_02", ntStart: 451 },
];

export function buildNanoporeDemoRounds(): TargetedRoundForm[] {
  const specs: Array<Array<[string, string, number]>> = [
    [["GCT", "TAC", 60], ["TGG", "TAC", 12], ["GCT", "CTG", 12], ["TGG", "CTG", 6]],
    [["GCT", "TAC", 40], ["TGG", "TAC", 30], ["GCT", "CTG", 30], ["TGG", "CTG", 30]],
    [["GCT", "TAC", 20], ["TGG", "TAC", 20], ["GCT", "CTG", 20], ["TGG", "CTG", 100]],
  ];
  return specs.map((groups, round) => {
    const records: string[] = [];
    let id = 0;
    for (const [site1, site2, count] of groups) for (let i = 0; i < count; i++) {
      let seq = replaceCodon(replaceCodon(NANOPORE_DEMO_REFERENCE, 61, site1), 451, site2);
      if (i % 11 === 0) seq = reverseComplement(seq);
      records.push(fastq(`demo_r${round}_${id++}`, seq, 20));
    }
    // Exercise explicit QC buckets without overwhelming the biological counts.
    records.push(fastq(`demo_r${round}_lowq`, NANOPORE_DEMO_REFERENCE, 5));
    records.push(fastq(`demo_r${round}_concatemer`, NANOPORE_DEMO_REFERENCE.repeat(2), 20));
    records.push(fastq(`demo_r${round}_partial`, replaceCodon(NANOPORE_DEMO_REFERENCE, 61, "TGG").slice(20, 150), 20));
    const midpoint = Math.ceil(records.length / 2);
    const shards = round === 1 ? [records.slice(0, midpoint), records.slice(midpoint)] : [records];
    return {
      id: `demo_round_${round}`,
      round,
      files: shards.map((part, shard) => {
        const ext = round === 0 ? "fastqsanger" : shard === 0 ? "fastq" : "fq";
        const file = new File([part.join("")], `nanopore_demo_round${round}_part${shard + 1}.${ext}`, { type: "text/plain" });
        return { id: `demo_file_${round}_${shard}`, file, driveRef: null };
      }),
    };
  });
}

function replaceCodon(seq: string, start1: number, codon: string): string { return seq.slice(0, start1 - 1) + codon + seq.slice(start1 + 2); }
function fastq(id: string, seq: string, q: number): string { return `@${id} qs:f:${q}\n${seq}\n+\n${String.fromCharCode(q + 33).repeat(seq.length)}\n`; }
function reverseComplement(seq: string): string { return [...seq].reverse().map((b) => ({ A: "T", C: "G", G: "C", T: "A" }[b]!)).join(""); }
