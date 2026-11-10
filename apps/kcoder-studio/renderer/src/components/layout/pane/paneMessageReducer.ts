import type { RuntimePaneMessageAction } from '@/features/workbench/runtimePaneMessages'
import { hasSettledAssistantMessage } from '@/features/workbench/runtimePaneStatus'
import { persistAttachmentReferences } from '@/lib/attachments'
import type { Attachment, RequestUserInputResponse } from '@/types/api'
import type { WorkbenchMessage } from '@/types/workbench'
import { isActiveToolCallStatus, reduceWorkbenchMessages } from '@wegent/chat-core'
import type { CodeCommentContext } from '@/types/workspace-files'
import { type GuidanceSplitBoundary } from './sessionTypes'
import { hasUnsettledRuntimePaneState } from './subagentState'

export const RUNTIME_TRANSCRIPT_PAGE_SIZE = 50

export interface CreateLocalUserMessageOptions {
  id?: string
  createdAt?: string
  runtimeGoalRequest?: boolean
  runtimeGuidance?: boolean
  codeComments?: CodeCommentContext[]
}

export function createLocalUserMessage(
  content: string,
  attachments?: Attachment[],
  options: CreateLocalUserMessageOptions = {}
): WorkbenchMessage {
  return {
    id: options.id ?? `runtime-local-pane-${Date.now()}`,
    role: 'user',
    content,
    attachments: attachments ? persistAttachmentReferences(attachments) : undefined,
    status: 'done',
    createdAt: options.createdAt ?? new Date().toISOString(),
    runtimeGoalRequest: options.runtimeGoalRequest ? true : undefined,
    runtimeGuidance: options.runtimeGuidance ? true : undefined,
    codeComments: options.codeComments?.length ? options.codeComments : undefined,
  }
}

export function splitActiveAssistantForGuidance(
  messages: WorkbenchMessage[],
  guidanceMessage: WorkbenchMessage,
  splitBoundaries: Map<string, GuidanceSplitBoundary>
): WorkbenchMessage[] {
  const assistantIndex = findLastIndex(
    messages,
    message => message.role === 'assistant' && message.status === 'streaming'
  )
  const messagesBeforeActiveAssistant =
    assistantIndex < 0 ? messages : messages.slice(0, assistantIndex)
  const interruptedAssistantIndex = findLastIndex(
    messagesBeforeActiveAssistant,
    message =>
      message.role === 'assistant' &&
      ['interrupted', 'cancelled', 'canceled', 'aborted'].includes(
        String(message.runtimeStatus ?? '').toLowerCase()
      )
  )
  const normalizedMessages =
    interruptedAssistantIndex < 0
      ? messages
      : messages.map((message, index) =>
          index === interruptedAssistantIndex ? { ...message, stoppedNotice: false } : message
        )
  if (assistantIndex < 0) {
    return [...normalizedMessages, guidanceMessage]
  }

  const assistantMessage = normalizedMessages[assistantIndex]
  if (assistantMessage?.subtaskId) {
    splitBoundaries.set(assistantMessage.subtaskId, {
      prefix: assistantMessage.content,
    })
  }

  const frozenAssistantMessage: WorkbenchMessage = {
    ...assistantMessage,
    id: `${assistantMessage.id}-before-guidance-${guidanceMessage.id}`,
    subtaskId: undefined,
    status: 'done',
    runtimeStatus: 'done',
    streamTextOffset: undefined,
    completedAt: guidanceMessage.createdAt,
    runtimeGuidanceSplitBefore: true,
    blocks: freezeGuidanceAssistantBlocks(assistantMessage.blocks),
  }

  const continuationMessage = assistantMessage.subtaskId
    ? createGuidanceContinuationAssistantMessage(
        { ...assistantMessage, subtaskId: assistantMessage.subtaskId },
        guidanceMessage
      )
    : null

  return [
    ...normalizedMessages.slice(0, assistantIndex),
    frozenAssistantMessage,
    guidanceMessage,
    ...(continuationMessage ? [continuationMessage] : []),
    ...normalizedMessages.slice(assistantIndex + 1),
  ]
}

export function createGuidanceContinuationAssistantMessage(
  assistantMessage: WorkbenchMessage & { subtaskId: string },
  guidanceMessage: WorkbenchMessage
): WorkbenchMessage {
  return {
    ...assistantMessage,
    id: `${assistantMessage.id}-after-guidance-${guidanceMessage.id}`,
    content: '',
    status: 'streaming',
    runtimeStatus: 'streaming',
    streamTextOffset: undefined,
    blocks: [
      {
        id: `${guidanceMessage.id}-guidance`,
        subtaskId: assistantMessage.subtaskId,
        type: 'tool',
        toolName: 'conversation_guidance',
        toolInput: { message: guidanceMessage.content },
        status: 'done',
        createdAt: getMessageCreatedAtMs(guidanceMessage.createdAt),
      },
    ],
    runtimeGuidanceContinuation: true,
    contentTruncated: undefined,
    contentOriginalChars: undefined,
    completedAt: undefined,
    stoppedNotice: false,
  }
}

export function transformRuntimePaneActionForGuidanceSplits(
  action: RuntimePaneMessageAction,
  splitBoundaries: Map<string, GuidanceSplitBoundary>
): RuntimePaneMessageAction {
  if (!('subtaskId' in action) || typeof action.subtaskId !== 'string') return action

  const boundary = splitBoundaries.get(action.subtaskId)
  if (!boundary) return action

  switch (action.type) {
    case 'assistant_chunk':
      return action
    case 'assistant_done': {
      splitBoundaries.delete(action.subtaskId)
      return {
        ...action,
        content:
          action.content === undefined
            ? undefined
            : trimGuidanceSplitPrefix(boundary.prefix, action.content),
      }
    }
    case 'assistant_error':
    case 'assistant_cancelled':
      splitBoundaries.delete(action.subtaskId)
      return action
    default:
      return action
  }
}

export function trimGuidanceSplitPrefix(prefix: string, content: string, offset?: number): string {
  if (!prefix || !content) return content

  const prefixLength = textCodePointLength(prefix)
  if (typeof offset === 'number' && Number.isFinite(offset)) {
    const contentLength = textCodePointLength(content)
    if (offset >= prefixLength) return content
    const coveredLength = prefixLength - offset
    if (coveredLength >= contentLength) return ''
    return sliceTextCodePoints(content, coveredLength)
  }

  if (content.startsWith(prefix)) {
    return content.slice(prefix.length)
  }
  return content
}

export function freezeGuidanceAssistantBlocks(
  blocks: WorkbenchMessage['blocks']
): WorkbenchMessage['blocks'] {
  return blocks?.map(block => {
    if (block.status !== 'streaming' && block.status !== 'pending') return block
    return {
      ...block,
      status: block.type === 'tool' ? 'done' : 'done',
    }
  })
}

export function textCodePointLength(value: string): number {
  return isAsciiText(value) ? value.length : Array.from(value).length
}

export function sliceTextCodePoints(value: string, start: number): string {
  if (start <= 0) return value
  if (isAsciiText(value)) return value.slice(start)
  return Array.from(value).slice(start).join('')
}

export function getMessageCreatedAtMs(createdAt: string): number {
  const timestamp = new Date(createdAt).getTime()
  return Number.isFinite(timestamp) ? timestamp : Date.now()
}

export function isAsciiText(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index)
    if (code > 0x7f) return false
  }
  return true
}

export function findLastIndex<T>(items: T[], predicate: (item: T) => boolean): number {
  for (let index = items.length - 1; index >= 0; index -= 1) {
    const item = items[index]
    if (item !== undefined && predicate(item)) return index
  }
  return -1
}

export function isEditableLastUserMessage(
  messages: WorkbenchMessage[],
  targetIndex: number
): boolean {
  if (targetIndex < 0 || targetIndex >= messages.length) return false

  const target = messages[targetIndex]
  if (target.role !== 'user') return false

  const followingMessages = messages.slice(targetIndex + 1)
  if (followingMessages.length === 0) return false
  if (followingMessages.some(message => message.role === 'user')) return false
  if (followingMessages.some(message => message.status === 'streaming')) return false

  return followingMessages.some(message => message.role === 'assistant')
}

export function reconcileRuntimeConversationMessages(
  transcriptMessages: WorkbenchMessage[],
  cachedMessages: WorkbenchMessage[],
  transcriptRunning: boolean
): WorkbenchMessage[] {
  if (transcriptMessages.length === 0) return cachedMessages
  if (!transcriptRunning && hasSettledAssistantMessage(transcriptMessages)) {
    return transcriptMessages
  }
  if (!hasUnsettledRuntimePaneState(cachedMessages)) return transcriptMessages
  if (!hasUnsettledRuntimePaneState(transcriptMessages)) return cachedMessages

  return runtimeMessageContentWeight(cachedMessages) >
    runtimeMessageContentWeight(transcriptMessages)
    ? cachedMessages
    : transcriptMessages
}

/** Preserve original process observations while keeping history authoritative. */
export function mergeBufferedTranscriptProcessing(
  transcriptMessages: WorkbenchMessage[],
  bufferedActions: RuntimePaneMessageAction[],
  transcriptRunning = false
): WorkbenchMessage[] {
  if (transcriptRunning || bufferedActions.length === 0) return transcriptMessages
  let observed: WorkbenchMessage[] = []
  for (const action of bufferedActions) observed = reduceWorkbenchMessages(observed, action)
  return transcriptMessages.map((message, index) => {
    if (message.role !== 'assistant' || message.status === 'streaming' || !message.turnId ||
        transcriptMessages.slice(index + 1).some(item => item.role === 'assistant' &&
          item.turnId === message.turnId)) return message
    const original = observed.find(item => item.role === 'assistant' && item.turnId === message.turnId &&
      (item.attemptId ?? item.turnId) === (message.attemptId ?? message.turnId))
    if (!original) return message
    const committedBlocks = transcriptMessages.filter(item => item.role === 'assistant' &&
      item.turnId === message.turnId).flatMap(item => item.blocks ?? [])
    const missing = (original.blocks ?? []).filter(block => block.type !== 'text' &&
      !committedBlocks.some(saved => saved.id === block.id ||
        (block.type === 'thinking' && saved.type === 'thinking')))
    if (!missing.length) return message
    return { ...message, blocks: [...(message.blocks ?? []), ...missing.map(block => ({ ...block,
      status: block.type === 'thinking' ? 'done' :
        isActiveToolCallStatus(block.status) ? 'unknown' : block.status,
    }))] }
  })
}

export function filterBufferedTranscriptActions(
  transcriptMessages: WorkbenchMessage[],
  bufferedActions: RuntimePaneMessageAction[],
  transcriptRunning = false
): RuntimePaneMessageAction[] {
  const latestTurnId = [...transcriptMessages].reverse().find(message => message.turnId)?.turnId
  const activeStart = transcriptRunning
    ? [...bufferedActions]
        .reverse()
        .find(
          action =>
            action.type === 'assistant_started' &&
            (!latestTurnId ||
              action.turnId === latestTurnId ||
              (!action.turnId && action.subtaskId === latestTurnId))
        )
    : undefined
  const activeSubtaskId =
    activeStart && 'subtaskId' in activeStart ? activeStart.subtaskId : undefined
  const settledTurnIds = new Set(
    transcriptMessages.flatMap(message => {
      const turnId = message.turnId?.trim()
      return message.role === 'assistant' && message.status !== 'streaming' && turnId
        ? [turnId]
        : []
    })
  )
  if (settledTurnIds.size === 0) return bufferedActions

  return bufferedActions.filter(action => {
    // A completed body segment is not the terminal state of its still-running attempt.
    if (activeSubtaskId && 'subtaskId' in action && action.subtaskId === activeSubtaskId)
      return true
    if (!('subtaskId' in action) || !action.subtaskId || !settledTurnIds.has(action.subtaskId)) {
      return true
    }

    if (action.type === 'block_created') {
      if (transcriptMessages.some(message => message.role === 'assistant' &&
          message.turnId === action.subtaskId && message.blocks?.some(block => block.id === action.block.id))) return false
    }
    if (action.type === 'block_updated' && isActiveToolCallStatus(action.updates.status)) return false

    // The transcript already contains this turn's authoritative terminal state;
    // replaying text lifecycle would create a second assistant. Tool blocks may
    // still receive background terminal events after turn completion, so retain block events.
    return ![
      'assistant_started',
      'assistant_cached',
      'assistant_chunk',
      'assistant_done',
      'assistant_error',
      'assistant_cancelled',
    ].includes(action.type)
  })
}

export function runtimeMessageContentWeight(messages: WorkbenchMessage[]): number {
  return messages.reduce(
    (total, message) =>
      total + message.content.length + JSON.stringify(message.blocks ?? []).length,
    0
  )
}

export function getLruMapValue<K, V>(map: Map<K, V>, key: K): V | undefined {
  const value = map.get(key)
  if (value === undefined) return undefined
  map.delete(key)
  map.set(key, value)
  return value
}

export function setLruMapValue<K, V>(map: Map<K, V>, key: K, value: V, maxSize: number) {
  map.delete(key)
  map.set(key, value)

  while (map.size > maxSize) {
    const oldestKey = map.keys().next().value
    if (oldestKey === undefined) return
    map.delete(oldestKey)
  }
}

export function transcriptSettlesLatestSeededTurn(
  transcriptMessages: WorkbenchMessage[],
  seededMessages: WorkbenchMessage[],
  transcriptRunning?: boolean
): boolean {
  if (transcriptRunning === true) return false
  const latestUserIndex = findLastIndex(seededMessages, message => message.role === 'user')
  const latestStreamingIndex = findLastIndex(
    seededMessages,
    message => message.role === 'assistant' && message.status === 'streaming'
  )
  if (latestStreamingIndex > latestUserIndex) {
    const active = seededMessages[latestStreamingIndex]
    const activeTurnId = active.turnId?.trim() || active.subtaskId?.trim()
    if (activeTurnId)
      return transcriptMessages.some(
        message =>
          message.role === 'assistant' &&
          message.status !== 'streaming' &&
          message.turnId?.trim() === activeTurnId
      )
  }
  const latestSeededUser = latestUserIndex >= 0 ? seededMessages[latestUserIndex] : undefined
  if (!latestSeededUser) return hasSettledAssistantMessage(transcriptMessages)

  const latestMatchingUserIndex = findLastIndex(
    transcriptMessages,
    message => message.role === 'user' && message.id === latestSeededUser.id
  )
  if (latestMatchingUserIndex < 0) return false

  return transcriptMessages
    .slice(latestMatchingUserIndex + 1)
    .some(message => message.role === 'assistant' && message.status !== 'streaming')
}

export function requestUserInputResponseText(response: RequestUserInputResponse): string {
  const answers = Object.values(response.answers)
    .flatMap(answer => answer.answers)
    .map(answer => answer.trim())
    .filter(Boolean)
  return answers.length > 0 ? answers.join('\n') : '继续'
}
