import { translateDna } from "./dna.js";

export interface TargetSiteInput {
  name: string;
  /** One-based nucleotide coordinate of the first base in the reference. */
  ntStart: number;
  /** Defaults to 3. Non-codon regions can be represented explicitly later. */
  length?: number;
}

export interface ResolvedTargetSite {
  name: string;
  ntStart: number;
  start0: number;
  end0: number;
  length: number;
  wtDna: string;
  wtAa: string | null;
}

export interface TargetConfigValidation {
  reference: string;
  sites: ResolvedTargetSite[];
}

export function normalizeReference(reference: string): string {
  return reference.replace(/\s/g, "").toUpperCase();
}

/** Validate and resolve user-facing 1-based target definitions. */
export function resolveTargetSites(
  referenceInput: string,
  inputs: ReadonlyArray<TargetSiteInput>,
): TargetConfigValidation {
  const reference = normalizeReference(referenceInput);
  if (reference.length === 0) throw new Error("Reference sequence is empty.");
  if (/[^ACGTN]/.test(reference)) {
    throw new Error("Reference contains characters other than A/C/G/T/N.");
  }
  if (inputs.length === 0) throw new Error("At least one target site is required.");

  const names = new Set<string>();
  const sites: ResolvedTargetSite[] = [];
  for (const input of inputs) {
    const name = input.name.trim();
    if (!name) throw new Error("Target site name must not be empty.");
    if (names.has(name)) throw new Error(`Duplicate target site name: ${name}.`);
    names.add(name);

    if (!Number.isInteger(input.ntStart) || input.ntStart < 1) {
      throw new Error(`Site ${name}: ntStart must be a positive 1-based integer.`);
    }
    const length = input.length ?? 3;
    if (!Number.isInteger(length) || length < 1) {
      throw new Error(`Site ${name}: length must be a positive integer.`);
    }
    const start0 = input.ntStart - 1;
    const end0 = start0 + length;
    if (end0 > reference.length) {
      throw new Error(`Site ${name}: interval ${input.ntStart}-${end0} exceeds reference length ${reference.length}.`);
    }

    const wtDna = reference.slice(start0, end0);
    sites.push({
      name,
      ntStart: input.ntStart,
      start0,
      end0,
      length,
      wtDna,
      wtAa: length % 3 === 0 && !wtDna.includes("N") ? translateDna(wtDna) : null,
    });
  }

  sites.sort((a, b) => a.start0 - b.start0 || a.name.localeCompare(b.name));
  for (let i = 1; i < sites.length; i++) {
    const prev = sites[i - 1]!;
    const curr = sites[i]!;
    if (curr.start0 < prev.end0) {
      throw new Error(`Target sites overlap: ${prev.name} and ${curr.name}.`);
    }
  }
  return { reference, sites };
}
