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

export { bandedAlign, bandedAlignAscii, type BandedAlignResult } from "./banded-align.js";

export {
  NanoporeEngine,
  DEFAULT_SETTINGS as NANOPORE_DEFAULT_SETTINGS,
  createTsScorer,
  resolveWtRois,
  type NanoporeSiteConfig,
  type NanoporeRoundConfig,
  type NanoporeSettings,
  type NanoporeSiteStats,
  type NanoporeRoundStats,
  type NanoporeGlobalBreakdown,
  type NanoporeOutcome,
  type SiteScorerLike,
  type DualAnchorSiteOutput,
} from "./nanopore.js";

export {
  runNanoporePipeline,
  type NanoporePipelineRequest,
  type NanoporePipelineProgress,
  type NanoporePipelineResult,
  type NanoporeSiteInput,
  type NanoporeRoundInput,
} from "./nanopore-pipeline.js";

export {
  runNanoporeAnalyzer,
  type NanoporeAnalyzerInput,
  type NanoporeAnalyzerOutput,
  type NanoporeAnalyzerRow,
} from "./nanopore-analyzer.js";

export {
  CDNA_METHODS,
  NANOPORE_METHODS,
  formatMethodsAsText,
  type MethodsDocument,
  type MethodsRunParams,
  type ColumnDoc,
} from "./methods.js";
