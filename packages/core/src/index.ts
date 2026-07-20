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
  readFastqRecordsResilient,
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
  DEFAULT_ENRICHMENT_PSEUDOCOUNT,
  LEGACY_ENRICHMENT_PSEUDOCOUNT,
  assertValidPseudocount,
  READS_PER_MILLION,
  rpmPseudocountAsCount,
  log2RpmRatio,
  seLog2Ratio,
  varLog2Ratio,
  seLog2RpmRatio,
  varLog2RpmRatio,
  log2RpmWtRatio,
  seLog2RpmWtRatio,
  varLog2RpmWtRatio,
  seLog2WtRatio,
  varLog2WtRatio,
} from "./stats.js";

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
  TARGETED_NANOPORE_METHODS,
  formatMethodsAsText,
  type MethodsDocument,
  type MethodsRunParams,
  type ColumnDoc,
} from "./methods.js";

export {
  doradoMeanQ,
  parseDoradoHeaderQ,
  resolveDoradoReadQ,
  type DoradoReadQ,
} from "./targeted-qscore.js";

export {
  normalizeReference,
  resolveTargetSites,
  isAllowedTargetDna,
  type TargetDesign,
  type TargetSiteInput,
  type ResolvedTargetSite,
  type TargetConfigValidation,
} from "./targeted-types.js";

export {
  estimateReferenceOffset,
  estimateReferenceOffsetIndexed,
  createTargetedReferenceSeedIndex,
  alignTargetedReference,
  alignTargetedReferenceWithEstimate,
  alignTargetedReferenceAscii,
  type CigarCode,
  type CigarOp,
  type TargetedAlignOptions,
  type TargetedAlignment,
  type TargetedDiagonalEstimate,
  type TargetedReferenceSeedIndex,
} from "./targeted-align.js";

export {
  projectTargetedEvents,
  type TargetedSubstitution,
  type TargetedInsertion,
  type TargetedDeletion,
  type TargetedVariantEvent,
} from "./targeted-events.js";

export {
  callTargetSites,
  buildTargetHaplotype,
  buildProtectedMask,
  type TargetSiteCallStatus,
  type TargetSiteCall,
  type TargetSiteCallSettings,
} from "./targeted-caller.js";

export {
  evaluateTargetedQc,
  type TargetedQcFailure,
  type TargetedQcSettings,
  type TargetedQcResult,
} from "./targeted-qc.js";

export {
  runTargetedNanoporePipeline,
  type TargetedPipelineSettings,
  type TargetedPipelineRequest,
  type TargetedPipelineProgress,
  type TargetedPipelineLogEvent,
  type TargetedPrimaryDropReason,
  type TargetedFileStats,
  type TargetedSiteRunStats,
  type TargetedRoundRunStats,
  type TargetedPipelineResult,
} from "./targeted-pipeline.js";
