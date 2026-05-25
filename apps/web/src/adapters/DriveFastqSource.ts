// IFastqSource that streams a Google Drive file via Drive API v3's
// files.get?alt=media endpoint. The fetch response body is a ReadableStream
// — no buffering into memory — so even multi-GB FASTQs work without OOM.
//
// Token refresh is delegated to the IAuthProvider so this class doesn't care
// whether the bearer is GIS, a backend-issued JWT, or a test stub.

import type { FastqSourceDescriptor, IAuthProvider, IFastqSource } from "@cdna/types";

const DRIVE_API_BASE = "https://www.googleapis.com/drive/v3";

export interface DriveFileMeta {
  id: string;
  name: string;
  sizeBytes: number | null;
}

export class DriveFastqSource implements IFastqSource {
  constructor(
    private readonly meta: DriveFileMeta,
    private readonly auth: IAuthProvider,
  ) {}

  describe(): FastqSourceDescriptor {
    return { id: this.meta.id, name: this.meta.name, sizeBytes: this.meta.sizeBytes };
  }

  async open(signal?: AbortSignal): Promise<ReadableStream<Uint8Array>> {
    const token = await this.auth.getToken();
    const url = `${DRIVE_API_BASE}/files/${encodeURIComponent(this.meta.id)}?alt=media`;
    const init: RequestInit = {
      headers: { Authorization: `Bearer ${token}` },
    };
    if (signal) init.signal = signal;
    const res = await fetch(url, init);
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      throw new Error(`Drive fetch failed: HTTP ${res.status} ${res.statusText}${body ? ` — ${body}` : ""}`);
    }
    if (!res.body) {
      throw new Error("Drive response has no body — cannot stream.");
    }
    return res.body;
  }
}
