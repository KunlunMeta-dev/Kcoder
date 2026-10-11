import type { RuntimeTaskAddress, RuntimeSubagentSteerResponse } from './api'

export interface RuntimeSubagentRun {
  parentSessionId: string
  agentId: string
  runId: string
}
export interface RuntimeSubagentSummary {
  agentId: string
  agentName?: string
  status: string
  acceptingMessages: boolean
  queueDepth: number
  headMessageId?: string
  headStatus?: string
  outputPath?: string
  transcriptPath?: string
  backgroundRun?: RuntimeSubagentRun
  canStop?: boolean
  presentation?: {
    role?: string
    goal?: string
    directory?: string
    progress?: string
    canStop?: boolean
    journalScope: string
  }
}
export interface RuntimeSubagentListResponse {
  threadId: string
  agents: RuntimeSubagentSummary[]
  journalScope: string
  capabilities: {
    artifacts: boolean
    publicTranscript: boolean
    pages: boolean
    live: boolean
    conversationStream?: boolean
    receipts: boolean
    steering: boolean
    stop: boolean
  }
}
export interface RuntimeSubagentAddressRequest {
  address: RuntimeTaskAddress
  agentId: string
}
export interface RuntimeSubagentReceipt {
  clientMessageId: string
  messageId: string
  status: string
  bodySummary: string
  acceptedAtMs: number
  appliedAtMs?: number
  /** Admission identity; it may precede the run that actually received a resumed command. */
  backgroundRun?: RuntimeSubagentRun
  /** Written only after a checkpoint and exact worker run/lease acknowledgement. */
  appliedBackgroundRun?: RuntimeSubagentRun
}
export interface RuntimeSubagentCommandReadResponse {
  threadId: string
  agentId: string
  receiptEpoch: number
  clientMessageId: string
  receipt?: RuntimeSubagentReceipt
}
export interface RuntimeSubagentCommandsResponse {
  threadId: string
  agentId: string
  receiptEpoch: number
  retainedCount: number
  retainedLimit: number
  offset: number
  nextOffset?: number
  receipts: RuntimeSubagentReceipt[]
}
export interface RuntimeSubagentLiveResponse {
  threadId: string
  agentId: string
  active: boolean
  unchanged: boolean
  revision?: number
  phase?: string
  content: string
  truncated: boolean
}
export interface RuntimeSubagentStopResponse {
  stopped: boolean
  status: string
  reasonCode?: string
  expectedBackgroundRun: RuntimeSubagentRun
}
export function receiptAsSteer(receipt: RuntimeSubagentReceipt): RuntimeSubagentSteerResponse {
  return {
    agentId: receipt.backgroundRun?.agentId ?? '',
    clientMessageId: receipt.clientMessageId,
    messageId: receipt.messageId,
    accepted: receipt.status !== 'rejected',
    queued: receipt.status.startsWith('queued_') || receipt.status === 'resuming',
    status: receipt.status,
  }
}

/** Runtime-bound interaction provenance, independent of model annotations. */
export interface RuntimeSourceAgent {
  parentSessionId: string
  agentId: string
  backgroundRun?: RuntimeSubagentRun
}

/** Same public messages/actions as the ordinary conversation, scoped to one worker run. */
export interface RuntimeSubagentConversationSnapshot {
  threadId: string
  agentId: string
  subscriptionId: string
  runId: string
  sequence: number
  active: boolean
  messages: import('./workbench').WorkbenchMessage[]
  activeAssistantItemId?: string | null
  nextAssistantItem?: number
}
export type RuntimeSubagentConversationEvent =
  | {
      type: 'disconnected'
      threadId: string
      agentId: string
      subscriptionId: string
      reason?: string
    }
  | ({ type: 'reset' } & RuntimeSubagentConversationSnapshot)
  | {
      type: 'event'
      threadId: string
      agentId: string
      subscriptionId: string
      runId: string
      sequence: number
      method: string
      params: Record<string, unknown>
      occurredAtMs?: number
      actions: import('@/features/workbench/runtimePaneMessages').RuntimePaneMessageAction[]
      terminalStatus?: 'completed' | 'interrupted' | 'failed'
    }
export interface RuntimeSubagentConversationSubscription {
  snapshot: RuntimeSubagentConversationSnapshot
  unsubscribe: () => Promise<void>
}
