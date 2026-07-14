import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { normalizeReference, resolveTargetSites, type ResolvedTargetSite, type TargetSiteInput } from "@cdna/core";
import { parse } from "yaml";

export interface TargetedRoundConfig {
  name: string;
  role: "input" | "selected" | "other";
  fastq: string;
}

export interface TargetedLocalConfig {
  schemaVersion: 1;
  reference: {
    sequence?: string;
    fasta?: string;
    crispressoJson?: string;
  };
  sites: TargetSiteInput[];
  rounds: TargetedRoundConfig[];
  qc?: {
    minReadQ?: number;
    minAlignmentIdentity?: number;
    minReferenceCoverage?: number;
    minProtectedIdentity?: number;
    maxProtectedIndelBases?: number;
  };
}

export interface ResolvedLocalConfig {
  configPath: string;
  reference: string;
  sites: ResolvedTargetSite[];
  rounds: TargetedRoundConfig[];
  qc: {
    minReadQ: number;
    minAlignmentIdentity: number;
    minReferenceCoverage: number;
    minProtectedIdentity: number;
    maxProtectedIndelBases: number;
  };
}

function assertObject(value: unknown, label: string): asserts value is Record<string, unknown> {
  if (value == null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be an object.`);
  }
}

export async function loadTargetedConfig(path: string): Promise<ResolvedLocalConfig> {
  const configPath = resolve(path);
  const base = dirname(configPath);
  const raw: unknown = parse(await readFile(configPath, "utf8"));
  assertObject(raw, "Configuration");
  if (raw.schemaVersion !== 1) throw new Error("schemaVersion must be 1.");
  assertObject(raw.reference, "reference");

  const referenceSources = [raw.reference.sequence, raw.reference.fasta, raw.reference.crispressoJson]
    .filter((value) => typeof value === "string" && value.length > 0);
  if (referenceSources.length !== 1) {
    throw new Error("reference must set exactly one of sequence, fasta, or crispressoJson.");
  }

  let reference: string;
  if (typeof raw.reference.sequence === "string") {
    reference = normalizeReference(raw.reference.sequence);
  } else if (typeof raw.reference.fasta === "string") {
    const fasta = await readFile(resolve(base, raw.reference.fasta), "utf8");
    reference = normalizeReference(fasta.split(/\r?\n/).filter((line) => !line.startsWith(">")).join(""));
  } else {
    const jsonPath = resolve(base, String(raw.reference.crispressoJson));
    const info: unknown = JSON.parse(await readFile(jsonPath, "utf8"));
    assertObject(info, "CRISPResso JSON");
    assertObject(info.running_info, "CRISPResso running_info");
    assertObject(info.running_info.args, "CRISPResso running_info.args");
    const serializedArgs = info.running_info.args;
    const args = serializedArgs.value ?? serializedArgs;
    assertObject(args, "CRISPResso argparse value");
    if (typeof args.amplicon_seq !== "string") {
      throw new Error("CRISPResso JSON does not contain running_info.args.amplicon_seq.");
    }
    reference = normalizeReference(args.amplicon_seq);
  }

  if (!Array.isArray(raw.sites)) throw new Error("sites must be an array.");
  const validation = resolveTargetSites(reference, raw.sites as TargetSiteInput[]);

  if (!Array.isArray(raw.rounds) || raw.rounds.length === 0) throw new Error("rounds must be a non-empty array.");
  const rounds = raw.rounds.map((round, index) => {
    assertObject(round, `rounds[${index}]`);
    if (typeof round.name !== "string" || !round.name.trim()) throw new Error(`rounds[${index}].name is required.`);
    if (round.role !== "input" && round.role !== "selected" && round.role !== "other") {
      throw new Error(`rounds[${index}].role must be input, selected, or other.`);
    }
    if (typeof round.fastq !== "string" || !round.fastq.trim()) throw new Error(`rounds[${index}].fastq is required.`);
    return {
      name: round.name,
      role: round.role as TargetedRoundConfig["role"],
      fastq: resolve(base, round.fastq),
    };
  });
  if (new Set(rounds.map((round) => round.name)).size !== rounds.length) {
    throw new Error("Round names must be unique.");
  }

  const qc = raw.qc == null ? {} : raw.qc;
  assertObject(qc, "qc");
  return {
    configPath,
    reference,
    sites: validation.sites,
    rounds,
    qc: {
      minReadQ: numberSetting(qc.minReadQ, 10, "qc.minReadQ", 0, 100),
      minAlignmentIdentity: numberSetting(qc.minAlignmentIdentity, 0.85, "qc.minAlignmentIdentity", 0, 1),
      minReferenceCoverage: numberSetting(qc.minReferenceCoverage, 0.9, "qc.minReferenceCoverage", 0, 1),
      minProtectedIdentity: numberSetting(qc.minProtectedIdentity, 0.95, "qc.minProtectedIdentity", 0, 1),
      maxProtectedIndelBases: integerSetting(qc.maxProtectedIndelBases, 0, "qc.maxProtectedIndelBases", 0),
    },
  };
}

function integerSetting(value: unknown, fallback: number, label: string, min: number): number {
  if (value == null) return fallback;
  if (!Number.isInteger(value) || (value as number) < min) {
    throw new Error(`${label} must be an integer greater than or equal to ${min}.`);
  }
  return value as number;
}

function numberSetting(value: unknown, fallback: number, label: string, min: number, max: number): number {
  if (value == null) return fallback;
  if (typeof value !== "number" || !Number.isFinite(value) || value < min || value > max) {
    throw new Error(`${label} must be a finite number from ${min} to ${max}.`);
  }
  return value;
}
