import type { TargetedAlignment } from "./targeted-align.js";

export interface TargetedSubstitution {
  type: "substitution";
  refPos0: number;
  readPos0: number;
  refBase: string;
  altBase: string;
}

export interface TargetedInsertion {
  type: "insertion";
  /** Insertion occurs between afterRefPos0 and afterRefPos0+1; -1 means before ref base 0. */
  afterRefPos0: number;
  readStart0: number;
  sequence: string;
}

export interface TargetedDeletion {
  type: "deletion";
  refStart0: number;
  readPos0: number;
  sequence: string;
}

export type TargetedVariantEvent = TargetedSubstitution | TargetedInsertion | TargetedDeletion;

const DEC = new TextDecoder("latin1");

/** Project an alignment CIGAR into normalized reference-coordinate events. */
export function projectTargetedEvents(
  reference: Uint8Array,
  read: Uint8Array,
  alignment: TargetedAlignment,
): TargetedVariantEvent[] {
  const events: TargetedVariantEvent[] = [];
  let refPos = 0;
  let readPos = alignment.readStart;
  for (const op of alignment.cigar) {
    if (op.code === "M") {
      refPos += op.length;
      readPos += op.length;
    } else if (op.code === "X") {
      for (let k = 0; k < op.length; k++) {
        events.push({
          type: "substitution",
          refPos0: refPos,
          readPos0: readPos,
          refBase: DEC.decode(reference.subarray(refPos, refPos + 1)),
          altBase: DEC.decode(read.subarray(readPos, readPos + 1)),
        });
        refPos++;
        readPos++;
      }
    } else if (op.code === "I") {
      events.push({
        type: "insertion",
        afterRefPos0: refPos - 1,
        readStart0: readPos,
        sequence: DEC.decode(read.subarray(readPos, readPos + op.length)),
      });
      readPos += op.length;
    } else {
      events.push({
        type: "deletion",
        refStart0: refPos,
        readPos0: readPos,
        sequence: DEC.decode(reference.subarray(refPos, refPos + op.length)),
      });
      refPos += op.length;
    }
  }
  if (refPos !== reference.length) {
    throw new Error(`CIGAR consumed ${refPos} reference bases; expected ${reference.length}.`);
  }
  return events;
}

