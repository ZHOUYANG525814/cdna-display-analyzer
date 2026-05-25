export const CORE_VERSION = "0.0.0";

export {
  CODON_TABLE,
  ASCII,
  reverseComplement,
  reverseComplementBytes,
  translateDna,
  calculateGc,
  hasNoStopCodon,
  decodeCds,
} from "./dna.js";

export {
  LineSplitter,
  readFastqRecords,
  meanPhred,
  bytesToAscii,
  type FastqRecord,
} from "./fastq.js";

export {
  DemultiplexEngine,
  preprocessRounds,
  indexOfBytes,
  reverseComplementBytesToBytes,
  rcInto,
  MAX_BARCODE_ERROR,
  MIN_VICTORY_MARGIN,
  type RoundConfigInput,
  type PreprocessedRound,
  type DemultiplexSettings,
  type ProcessResult,
  type UnassignedReason,
  type RoundStats,
  type UnassignedBreakdown,
} from "./demultiplex.js";

export {
  runAnalyzer,
  buildColumnSpecs,
  serializeCsv,
  type AnalyzerInput,
  type AnalyzerOutput,
  type AnalyzerRow,
  type ColumnSpec,
  type RowValue,
} from "./analyzer.js";

export {
  runPipeline,
  buildRunStatsJson,
  type PipelineRequest,
  type PipelineProgress,
  type PipelineResult,
} from "./pipeline.js";
