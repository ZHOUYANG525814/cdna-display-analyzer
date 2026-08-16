import { afterEach, describe, expect, it, vi } from "vitest";
import type { IAuthProvider } from "@cdna/types";
import { DriveFastqSource } from "../src/adapters/DriveFastqSource";

afterEach(() => vi.unstubAllGlobals());

describe("DriveFastqSource token lifecycle", () => {
  it("requests a fresh token every time a file stream is opened", async () => {
    let tokenCalls = 0;
    const auth: IAuthProvider = {
      async signIn() {}, async signOut() {}, isSignedIn: () => true,
      async getToken() { tokenCalls++; return `token-${tokenCalls}`; },
    };
    const authorizations: string[] = [];
    vi.stubGlobal("fetch", vi.fn(async (_url: string, init?: RequestInit) => {
      authorizations.push(new Headers(init?.headers).get("Authorization") ?? "");
      return new Response(new Uint8Array([1, 2, 3]));
    }));
    const source = new DriveFastqSource({ id: "drive-id", name: "reads.fastq", sizeBytes: 3 }, auth);
    await source.open();
    await source.open();
    expect(tokenCalls).toBe(2);
    expect(authorizations).toEqual(["Bearer token-1", "Bearer token-2"]);
  });
});
