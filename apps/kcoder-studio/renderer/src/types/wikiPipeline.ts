/** Generated from kcoder_types::wiki_pipeline; batch is a source cursor, not an ordinal. */
import { knownValues } from '../../../shared/generated/contracts'
import type {
  WikiPipelineStageKind,
  WikiPipelineStageStatus,
} from '../../../shared/generated/contracts'

export type {
  WikiPipelineProgress,
  WikiPipelineStageAddress,
  WikiPipelineStageKind,
  WikiPipelineStageRecord,
  WikiPipelineStageStatus,
} from '../../../shared/generated/contracts'

export const wikiPipelineStages =
  knownValues.WikiPipelineStageKind as readonly WikiPipelineStageKind[]
export const wikiPipelineStatuses =
  knownValues.WikiPipelineStageStatus as readonly WikiPipelineStageStatus[]
