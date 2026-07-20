import { describe, expect, it } from "vitest";
import {
  peekFastq,
  validateDriveFastqRef,
  validateFastqFileName,
  validateFastqFileSync,
} from "../src/lib/validation";
import { useRunStore } from "../src/state/useRunStore";

describe("NGS FASTQ input validation", () => {
  it.each(["reads.fastq", "reads.FASTQ", "reads.fq"])(
    "accepts %s",
    (name) => expect(validateFastqFileName(name, 100).ok).toBe(true),
  );

  it.each([
    "reads.txt",
    "reads.fastq.gz",
    "../reads.fastq",
    "bad\u0000.fastq",
    `${"a".repeat(256)}.fastq`,
  ])("rejects unsafe or unsupported filename %s", (name) => {
    expect(validateFastqFileName(name, 100).ok).toBe(false);
  });

  it("rejects empty files, invalid sizes, and forged Drive IDs", () => {
    expect(validateFastqFileSync(new File([], "empty.fastq")).ok).toBe(false);
    expect(validateFastqFileName("reads.fastq", -1).ok).toBe(false);
    expect(
      validateDriveFastqRef({
        id: "../../token",
        name: "reads.fastq",
        sizeBytes: 100,
      }).ok,
    ).toBe(false);
    expect(
      validateDriveFastqRef({
        id: "valid_drive-id_1",
        name: "reads.sam",
        sizeBytes: 100,
      }).ok,
    ).toBe(false);
  });

  it.each([
    ["missing header", "read\nACGT\n+\nIIII\n"],
    ["empty read ID", "@\nACGT\n+\nIIII\n"],
    ["whitespace read ID", "@ \nACGT\n+\nIIII\n"],
    ["missing separator", "@r\nACGT\nnot-plus\nIIII\n"],
    ["invalid base", "@r\nACGX\n+\nIIII\n"],
    ["length mismatch", "@r\nACGT\n+\nIII\n"],
    ["invalid Phred byte", "@r\nACGT\n+\nIII \n"],
    ["truncated record", "@r\nACGT\n+\n"],
  ])("rejects first-record error: %s", async (_label, content) => {
    const result = await peekFastq(new File([content], "bad.fastq"));
    expect(result.ok).toBe(false);
    expect(result.level).toBe("error");
  });

  it("accepts lowercase bases, CRLF, and a valid 50 kb first read", async () => {
    const sequence = "acgtn".repeat(10_000);
    const quality = "I".repeat(sequence.length);
    const file = new File(
      [`@long read\r\n${sequence}\r\n+\r\n${quality}\r\n`],
      "long.fastq",
    );
    expect(await peekFastq(file)).toEqual({ ok: true });
  });

  it("caps file and round counts at the same limits used by locked-config import", () => {
    useRunStore.getState().resetAll();
    useRunStore.getState().setLocalFiles(
      Array.from(
        { length: 1_001 },
        (_, index) => new File(["x"], `reads_${index}.fastq`),
      ),
    );
    expect(useRunStore.getState().localFiles).toHaveLength(1_000);
    for (let index = 0; index < 110; index++) {
      useRunStore.getState().addRound();
    }
    expect(useRunStore.getState().rounds).toHaveLength(100);
    useRunStore.getState().resetAll();
  });
});
