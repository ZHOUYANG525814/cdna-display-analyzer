export interface RoundConfig {
  id: number;
  name: string;
  fwPrimer: string;
  rvPrimer: string;
  cdsStart: number;
  cdsEnd: number;
}

export interface Settings {
  adaptive: boolean;
  filterStop: boolean;
  minMeanPhred: number;
}

export interface RoundStats {
  totalAssigned: number;
  discardTruncated: number;
  discardLengthIndel: number;
  discardStopCodon: number;
  passedQc: number;
}

export interface PipelineResult {
  dnaCounters: Map<string, Map<string, number>>;
  stats: Map<string, RoundStats>;
  globalUnassigned: number;
}

export interface ProgressEvent {
  fileId: string;
  bytesProcessed: number;
  totalBytes: number | null;
  recordsProcessed: number;
}

export interface IAuthProvider {
  signIn(): Promise<void>;
  signOut(): Promise<void>;
  getToken(): Promise<string>;
  isSignedIn(): boolean;
}

export interface FastqSourceDescriptor {
  id: string;
  name: string;
  sizeBytes: number | null;
}

export interface IFastqSource {
  describe(): FastqSourceDescriptor;
  open(signal?: AbortSignal): Promise<ReadableStream<Uint8Array>>;
}

export interface ExportArtifacts {
  csv: string;
  qcReport: string;
  parquet?: Uint8Array;
}

export interface IExporter {
  write(artifacts: ExportArtifacts, projectName: string): Promise<void>;
}
