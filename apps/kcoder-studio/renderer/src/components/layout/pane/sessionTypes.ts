import type {
  RuntimeAdditionalContext,
  RuntimeExecutionModes,
  RuntimeGoal,
  RuntimeTaskAddress,
} from '@/types/api'

export interface WorkbenchPaneSessionOptions {
  currentRuntimeTask: RuntimeTaskAddress | null
}

export interface SendRequestUserInputResponseOptions {
  appendUserMessage?: boolean
  forceDefaultCollaborationMode?: boolean
}

export interface RuntimePaneSendOptions extends RuntimeExecutionModes {
  computerUse?: import('@/types/api').RuntimeComputerUseAuthorization
  onExecutionModeAccepted?: () => void
  guideWhenBusy?: boolean
  interruptWhenBusy?: boolean
  additionalContext?: RuntimeAdditionalContext
  onRuntimeTaskCreated?: (address: RuntimeTaskAddress) => void
}

export interface SendRuntimeMessageOptions {
  computerUse?: import('@/types/api').RuntimeComputerUseAuthorization
  appendLocalMessage?: boolean
}

export interface LoadedTranscriptRange {
  start: number
  end: number
}

export interface RuntimeTaskLoadTarget {
  key: string
  identityKey: string
  address: RuntimeTaskAddress
}

export interface PendingRuntimeGoalState {
  creationPending?: boolean
  goal: RuntimeGoal
  targetKey: string | null
  targetIdentityKey: string | null
}

export interface GuidanceSplitBoundary {
  prefix: string
}
