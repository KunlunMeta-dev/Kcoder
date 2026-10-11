import type { RuntimeTaskAddress } from '@/types/api'
import type { WorkbenchMessage } from '@/types/workbench'
import type { RuntimeTaskLifecycleSnapshot } from './runtimeTaskLifecycle'

export type RuntimePaneSendPhase = 'idle' | 'submitting' | 'awaiting_assistant'

export interface RuntimePaneStatus {
  sendPhase: RuntimePaneSendPhase
  activeAssistantMessage: WorkbenchMessage | null
  taskExecution: {
    known: boolean
    running: boolean
    continuable: boolean
    status: string | null
  }
  isSubmitting: boolean
  isAwaitingAssistant: boolean
  isAssistantStreaming: boolean
  isResponseActive: boolean
  isBusy: boolean
  isWaitingForAssistantIndicator: boolean
  canSendQueuedMessage: boolean
  hasRunningShortenableTool: boolean
}

export function deriveRuntimePaneStatus({
  messages,
  currentRuntimeTask,
  lifecycle,
}: {
  messages: WorkbenchMessage[]
  currentRuntimeTask: RuntimeTaskAddress | null
  lifecycle: RuntimeTaskLifecycleSnapshot | null
}): RuntimePaneStatus {
  const turnPhase = lifecycle?.turn.phase ?? 'idle'
  const sendPhase: RuntimePaneSendPhase =
    turnPhase === 'submitting'
      ? 'submitting'
      : turnPhase === 'awaiting'
        ? 'awaiting_assistant'
        : 'idle'
  const activeAssistantMessage =
    turnPhase === 'streaming' ? (findActiveAssistantMessage(messages) ?? null) : null
  const isSubmitting = turnPhase === 'submitting'
  const isAwaitingAssistant = turnPhase === 'awaiting'
  const isAssistantStreaming = turnPhase === 'streaming'
  const isResponseActive = lifecycle?.derived.isTurnActive ?? false
  const isBusy = lifecycle?.derived.isBusy ?? false
  // During Sleep/wait, the stop control offers the first Escape action: skip waiting.
  // Inspect only the streaming assistant message. Interrupted or restored history
  // may retain unsettled tool blocks and must not affect unrelated later calls.
  const hasRunningShortenableTool = Boolean(
    activeAssistantMessage?.blocks?.some(
      block =>
        block.type === 'tool' &&
        block.status !== 'done' &&
        block.status !== 'error' &&
        isShortenableWaitTool(block.toolName)
    )
  )
  const running = lifecycle?.derived.isRunning ?? false
  const continuable = lifecycle?.continuable ?? false

  return {
    sendPhase,
    activeAssistantMessage,
    taskExecution: {
      known: lifecycle?.execution.known ?? false,
      running,
      continuable,
      status: lifecycle?.task?.status?.trim().toLowerCase() || null,
    },
    isSubmitting,
    isAwaitingAssistant,
    isAssistantStreaming,
    isResponseActive,
    isBusy,
    hasRunningShortenableTool,
    isWaitingForAssistantIndicator:
      isSubmitting || isAwaitingAssistant || (running && !isAssistantStreaming),
    canSendQueuedMessage: Boolean(currentRuntimeTask) && continuable && !isBusy,
  }
}

/**
 * Tool names whose wait can be shortened by cancelling the wait instead of the turn.
 *
 * Only the dedicated wait tools qualify; a shell asleep inside `Bash` cannot be shortened and
 * must keep the plain stop button. Matching tolerates the casing/spacing that different
 * runtimes report.
 */
export function isShortenableWaitTool(toolName: string | null | undefined): boolean {
  const name = toolName?.trim().toLowerCase()
  return name === 'sleep' || name === 'wait'
}

export function findActiveAssistantMessage(
  messages: WorkbenchMessage[]
): WorkbenchMessage | undefined {
  return [...messages]
    .reverse()
    .find(message => message.role === 'assistant' && message.status === 'streaming')
}

export function hasSettledAssistantMessage(messages: WorkbenchMessage[]): boolean {
  return (
    messages.some(message => message.role === 'assistant') && !findActiveAssistantMessage(messages)
  )
}
