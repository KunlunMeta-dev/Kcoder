// Self-evolution wire types come from the generated `kcoder_app_protocol::evolution`
// contract. This module only adds client-side names, method constants and the
// aliases the UI uses; it defines no wire shape of its own.
import type {
  EvolutionDataScope,
  EvolutionErrorCode,
  EvolutionEvaluationSummary,
  EvolutionTargetTypeStatus,
  OverlayContent,
  ProposalExample,
  ProposalState,
  TargetType,
} from '../../../../shared/generated/contracts'

export type {
  EvolutionChangedNotification,
  EvolutionChangedReason,
  EvolutionCost,
  EvolutionDataClearParams,
  EvolutionDataClearResult,
  EvolutionDataScope,
  EvolutionDecision,
  EvolutionDisabledReason,
  EvolutionDistillOutcome,
  EvolutionErrorCode,
  EvolutionItemSetting,
  EvolutionJobStatus,
  EvolutionMode,
  EvolutionModelRef,
  EvolutionModelStatus,
  EvolutionOverlayUpdateParams,
  EvolutionOverlayUpdateResult,
  EvolutionPattern,
  EvolutionPatternScope,
  EvolutionPreferenceItem,
  EvolutionPreferenceListResult,
  EvolutionPreferenceUpdateParams,
  EvolutionPreferenceUpdateResult,
  EvolutionProjectScopeIssue,
  EvolutionProposalDecideParams,
  EvolutionProposalDecideResult,
  EvolutionProposalSummary,
  EvolutionRatableTurn,
  EvolutionRateParams,
  EvolutionRateResult,
  EvolutionRating,
  EvolutionRatingsListParams,
  EvolutionRatingsListResult,
  EvolutionScore,
  EvolutionSettings,
  EvolutionSettingsReadResult,
  EvolutionSettingsSaveParams,
  EvolutionStatusParams,
  EvolutionStatusResult,
  EvolutionStorageDiagnostics,
  EvolutionTargetDistillParams,
  EvolutionTargetDistillResult,
  EvolutionTargetReadParams,
  EvolutionTargetReadResult,
  EvolutionTargetSetting,
  EvolutionTargetsListParams,
  EvolutionTargetsListResult,
  EvolutionTargetSummary,
  EvolutionUsageSummary,
  EvolutionWriteMode,
  OverlayContent,
  ProposalState,
  TargetKey,
  TargetType,
} from '../../../../shared/generated/contracts'

// UI-facing aliases of generated types.
export type EvolutionTargetType = TargetType
export type EvolutionStatusTarget = EvolutionTargetTypeStatus
export type EvolutionOverlayContent = OverlayContent
export type EvolutionOverlayExample = ProposalExample
export type EvolutionProposalEvaluation = EvolutionEvaluationSummary
export type EvolutionProposalState = ProposalState
export type EvolutionClearScope = EvolutionDataScope

/** Capability a target must advertise before any `evolution/*` request. */
export const SELF_EVOLUTION_CAPABILITY = 'selfEvolutionV1'

export const EVOLUTION_METHODS = {
  status: 'evolution/status',
  targetsList: 'evolution/targets/list',
  targetRead: 'evolution/target/read',
  targetDistill: 'evolution/target/distill',
  proposalDecide: 'evolution/proposal/decide',
  overlayUpdate: 'evolution/overlay/update',
  preferenceList: 'evolution/preference/list',
  preferenceUpdate: 'evolution/preference/update',
  rate: 'evolution/rate',
  ratingsList: 'evolution/ratings/list',
  dataClear: 'evolution/data/clear',
} as const

export type EvolutionMethod = (typeof EVOLUTION_METHODS)[keyof typeof EVOLUTION_METHODS]

/** Revision-checked `evolution.*` user settings, routed through `runtime.settings.request`. */
export const EVOLUTION_SETTINGS_METHODS = {
  read: 'settings/evolution/read',
  save: 'settings/evolution/save',
} as const

export const EVOLUTION_CHANGED_NOTIFICATION = 'evolution/changed'

export const EVOLUTION_TARGET_TYPES = [
  'skill',
  'preference',
  'project_knowledge',
  'tool_usage',
  'workflow_template',
] as const satisfies readonly TargetType[]

export const EVOLUTION_PROPOSAL_STATES = [
  'draft',
  'evaluated',
  'canary',
  'promoted',
  'rolled_back',
  'rejected',
] as const satisfies readonly ProposalState[]

export const EVOLUTION_RATE_REASON_MAX_CHARS = 500
/** Most tool call ids one `evolution/rate` request may name. */
export const EVOLUTION_RATE_TOOL_CALLS_MAX = 64

export const EVOLUTION_ERROR_CODES = [
  'evolution_disabled',
  'evolution_unsupported_target_type',
  'evolution_target_not_found',
  'evolution_revision_conflict',
  'evolution_proposal_not_found',
  'evolution_invalid_transition',
  'evolution_content_rejected',
  'evolution_content_too_large',
] as const satisfies readonly EvolutionErrorCode[]
