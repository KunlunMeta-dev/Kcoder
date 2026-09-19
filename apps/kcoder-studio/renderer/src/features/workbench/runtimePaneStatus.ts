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
  // TUI Escape 的第一段语义在 Studio 的等价物：Sleep / wait 工具运行时，
  // 停止按钮变为「跳过等待」。
  //
  // 只看当前正在流式的助手消息：历史消息里可能留下状态没有落定的等待块（回合被中断、
  // 应用重启或流事件丢失），若把它们算进来，后续无关的工具调用上也会一直显示
  // 「跳过等待」。等待进行中时它的块一定在当前消息里。
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
