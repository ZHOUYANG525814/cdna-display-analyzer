// IFastqSource backed by a File from <input type="file"> or drag-drop. Same
// shape as the future DriveFastqSource so the pipeline code is identical.
// Useful both for testing (no Drive credentials needed) and as a "first-class"
// option for users who'd rather upload directly.

import type { FastqSourceDescriptor, IFastqSource } from "@cdna/types";

export class LocalFastqSource implements IFastqSource {
  constructor(private readonly file: File) {}

  describe(): FastqSourceDescriptor {
    return { id: this.file.name, name: this.file.name, sizeBytes: this.file.size };
  }

  async open(_signal?: AbortSignal): Promise<ReadableStream<Uint8Array>> {
    // File.stream() returns a byte ReadableStream. The stream pulls chunks
    // lazily, so the entire file is never held in memory at once — matches
    // the streaming model we want from Drive.
    return this.file.stream();
  }
}
