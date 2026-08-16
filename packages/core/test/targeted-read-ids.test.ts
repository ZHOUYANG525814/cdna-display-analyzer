import { describe, expect, it } from "vitest";
import { TargetedReadIdSet } from "../src/targeted-read-ids.js";

describe("TargetedReadIdSet", () => {
  it("deduplicates complete UUID values without conflating close IDs", () => {
    const ids = new TargetedReadIdSet();
    expect(ids.add("00000000-0000-0000-0000-000000000001")).toBe(true);
    expect(ids.add("00000000-0000-0000-0000-000000000002")).toBe(true);
    expect(ids.add("00000000-0000-0000-0000-000000000001")).toBe(false);
    expect(ids.size).toBe(2);
  });

  it("grows while retaining exact UUID membership", () => {
    const ids = new TargetedReadIdSet();
    for (let index = 0; index < 10_000; index++) {
      const suffix = index.toString(16).padStart(12, "0");
      expect(ids.add(`12345678-1234-1234-1234-${suffix}`)).toBe(true);
    }
    expect(ids.add("12345678-1234-1234-1234-000000000999")).toBe(false);
    expect(ids.size).toBe(10_000);
  });

  it("keeps arbitrary and differently-cased identifiers exact", () => {
    const ids = new TargetedReadIdSet();
    expect(ids.add("read A")).toBe(true);
    expect(ids.add("read A")).toBe(false);
    expect(ids.add("ABCDEF00-0000-0000-0000-000000000000")).toBe(true);
    expect(ids.add("abcdef00-0000-0000-0000-000000000000")).toBe(true);
  });
});
