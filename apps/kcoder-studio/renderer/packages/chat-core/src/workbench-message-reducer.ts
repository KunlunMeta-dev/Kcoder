// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import type { WebSourcesV1 } from '../../../../shared/webSources'
import { decodeProviderFailure, type ProviderFailureDetails } from './provider-failure'
import {
  decodeToolCallStatus,
  isActiveToolCallStatus,
  canAcceptToolCallUpdate,
  type ToolCallStatus,
} from '../../../../shared/toolCallStatus'
export {
  decodeToolCallStatus as decodeWorkbenchBlockStatus,
  isActiveToolCallStatus,
} from '../../../../shared/toolCallStatus'

export type WorkbenchMessageRole = 'user' | 'assistant' | 'system'
export type WorkbenchMessageStatus = 'pending' | 'streaming' | 'done' | 'failed' | 'unknown'
export type WorkbenchRuntimeMessageStatus = WorkbenchMessageStatus | 'cancelled'
export type WorkbenchToolBlockStatus = ToolCallStatus['status']

export interface MessageSource {
  source: string
  [key: string]: unknown
}

export interface BaseWorkbenchProcessingBlock {
  id: string
  subtaskId: string
  status: WorkbenchToolBlockStatus
  rawStatus?: string
  createdAt: number
  completedAt?: number
  displayText?: Record<string, string>
  contentTruncated?: boolean
  contentOriginalChars?: number
  contentLoadRef?: WorkbenchContentLoadRef
}

export interface WorkbenchToolBlock extends BaseWorkbenchProcessingBlock {
  type: 'tool'
  toolName: string
  toolInput?: Record<string, unknown>
  toolOutput?: unknown
  toolOutputTruncated?: boolean
  toolOutputOriginalBytes?: number
  toolOutputOriginalChars?: number
  toolOutputLoadRef?: WorkbenchContentLoadRef
  webSources?: WebSourcesV1
  renderPayload?: unknown
  /** Transient argument estimate from this tool's stream, never a file receipt. */
  generatedLineProgress?: WorkbenchGeneratedLineProgress
}

export interface WorkbenchGeneratedLineProgress {
  generatedLines: number
  replacedLines?: number
}

export function normalizeGeneratedLineProgress(
  value: unknown
): WorkbenchGeneratedLineProgress | undefined {
  if (!value || typeof value !== 'object') return undefined
  const data = value as Record<string, unknown>
  if (
    typeof data.generatedLines !== 'number' ||
    !Number.isSafeInteger(data.generatedLines) ||
    data.generatedLines < 0
  )
    return undefined
  if (
    data.replacedLines !== undefined &&
    (typeof data.replacedLines !== 'number' ||
      !Number.isSafeInteger(data.replacedLines) ||
      data.replacedLines < 0)
  )
    return undefined
  return {
    generatedLines: data.generatedLines,
    ...(typeof data.replacedLines === 'number' ? { replacedLines: data.replacedLines } : {}),
  }
}

export interface WorkbenchThinkingBlock extends BaseWorkbenchProcessingBlock {
  type: 'thinking'
  content: string
}

export interface WorkbenchTextBlock extends BaseWorkbenchProcessingBlock {
  type: 'text'
  content: string
}

export interface WorkbenchPlanBlock extends BaseWorkbenchProcessingBlock {
  type: 'plan'
  content: string
}

export interface WorkbenchFileChangesBlock<
  TFileChanges = unknown,
> extends BaseWorkbenchProcessingBlock {
  type: 'file_changes'
  fileChanges: TFileChanges
}

export type WorkbenchProcessingBlock<TFileChanges = unknown> =
  | WorkbenchToolBlock
  | WorkbenchThinkingBlock
  | WorkbenchTextBlock
  | WorkbenchPlanBlock
  | WorkbenchFileChangesBlock<TFileChanges>

export interface WorkbenchMessage<TAttachment = unknown, TFileChanges = unknown> {
  /** Last model chunk kind; distinguishes new reasoning from earlier retained prose. */
  latestModelActivity?: 'text' | 'thinking'
  id: string
  taskId?: string
  subtaskId?: string
  turnId?: string
  attemptId?: string
  shellType?: string
  role: WorkbenchMessageRole
  content: string
  status: WorkbenchMessageStatus
  rawStatus?: string
  error?: string
  errorType?: string
  providerFailure?: ProviderFailureDetails
  attachments?: TAttachment[]
  blocks?: WorkbenchProcessingBlock<TFileChanges>[]
  fileChanges?: TFileChanges
  fileChangesCapture?: unknown
  reviewEvidence?: unknown
  source?: MessageSource
  runtimeStatus?: WorkbenchRuntimeMessageStatus | null
  completedAt?: string | number | null
  stoppedNotice?: boolean | null
  streamTextOffset?: number
  /** A peer message separated this live turn into visible transcript segments. */
  streamSegmentClosed?: boolean
  contentTruncated?: boolean
  contentOriginalChars?: number
  contentLoadRef?: WorkbenchContentLoadRef
  createdAt: string
}

export interface WorkbenchContentLoadRef {
  taskId?: string
  messageId?: string
  subtaskId?: string
  blockId?: string
  kind: 'message_content' | 'block_content' | 'tool_output'
}

type ProcessingBlockUpdate = {
  content?: string
  toolInput?: Record<string, unknown>
  toolOutput?: unknown
  toolOutputDelta?: string
  toolOutputTruncated?: boolean
  toolOutputOriginalBytes?: number
  webSources?: WebSourcesV1
  renderPayload?: unknown
  fileChanges?: unknown
  status?: WorkbenchToolBlockStatus
  rawStatus?: string
}

const MAX_LIVE_MESSAGE_CONTENT_CHARS = 200_000
const MAX_LIVE_BLOCK_CONTENT_CHARS = 120_000
const MAX_LIVE_TOOL_OUTPUT_CHARS = 64 * 1024

export type WorkbenchMessageAction<TAttachment = unknown, TFileChanges = unknown> =
  | { type: 'reset'; messages: WorkbenchMessage<TAttachment, TFileChanges>[] }
  | { type: 'user_added'; message: WorkbenchMessage<TAttachment, TFileChanges> }
  | { type: 'peer_added'; message: WorkbenchMessage<TAttachment, TFileChanges>; subtaskId?: string }
  /** A model item can finish before the tools it requested. Only the enclosing turn settles those tools. */
  | { type: 'assistant_item_phase'; subtaskId: string; phase: 'thinking' | 'completed' }
  | {
      type: 'assistant_started'
      occurredAtMs?: number
      messageId?: string
      taskId?: string
      subtaskId?: string
      turnId?: string
      attemptId?: string
      shellType?: string
    }
  | {
      type: 'assistant_cached'
      messageId?: string
      taskId?: string
      subtaskId?: string
      content: string
      blocks?: WorkbenchProcessingBlock<TFileChanges>[]
    }
  | {
      type: 'assistant_chunk'
      occurredAtMs?: number
      messageId?: string
      subtaskId?: string
      content: string
      offset?: number
      reasoningChunk?: string
      blocks?: WorkbenchProcessingBlock<TFileChanges>[]
    }
  | {
      type: 'assistant_done'
      occurredAtMs?: number
      messageId?: string
      subtaskId?: string
      turnId?: string
      content?: string
      blocks?: WorkbenchProcessingBlock<TFileChanges>[]
      fileChanges?: TFileChanges
      fileChangesCapture?: unknown
  reviewEvidence?: unknown
    }
  | {
      type: 'assistant_cancelled'
      occurredAtMs?: number
      messageId?: string
      subtaskId?: string
      content?: string
    }
  | {
      type: 'file_changes_updated'
      subtaskId: string
      fileChanges: TFileChanges
    }
  | { type: 'file_capture_updated'; subtaskId: string; capture: unknown }
  | { type: 'review_evidence_updated'; subtaskId: string; evidence: unknown }
  | {
      type: 'assistant_error'
      occurredAtMs?: number
      messageId?: string
      subtaskId?: string
      error: string
      errorType?: string
      providerFailure?: ProviderFailureDetails
    }
  | {
      type: 'block_created'
      messageId?: string
      subtaskId?: string
      block: WorkbenchProcessingBlock<TFileChanges>
    }
  | {
      type: 'block_updated'
      taskId?: string
      turnId?: string
      attemptId?: string
      messageId?: string
      subtaskId?: string
      blockId: string
      updates: ProcessingBlockUpdate
    }

export function isGenericTaskStatusError(error?: string): boolean {
  return /^(?:Task failed with status:\s*\w+|failed|error)$/i.test(String(error ?? '').trim())
}

export function reduceWorkbenchMessages<TAttachment = unknown, TFileChanges = unknown>(
  state: WorkbenchMessage<TAttachment, TFileChanges>[],
  action: WorkbenchMessageAction<TAttachment, TFileChanges>
): WorkbenchMessage<TAttachment, TFileChanges>[] {
  // Only an authoritative reset can replace a future attempt's historical facts.
  // Stream replay and synthesized completion cannot grant a known outcome.
  if (
    action.type !== 'peer_added' &&
    ('messageId' in action || 'subtaskId' in action) &&
    state.some(
      message =>
        message.status === 'unknown' &&
        (isAssistantMessageForAction(message, action) ||
          (typeof action.subtaskId === 'string' && message.turnId === action.subtaskId))
    )
  ) {
    return state
  }
  switch (action.type) {
    case 'reset':
      return normalizeUniqueWorkbenchMessages(action.messages).map(message =>
        limitWorkbenchMessage(message)
      )
    case 'user_added': {
      const existing = state.findIndex(m => m.id === action.message.id && m.role === 'user')
      if (existing >= 0) return state.map((message, index) => index === existing
        ? limitWorkbenchMessage(mergeDuplicateWorkbenchMessage(message, action.message)) : message)
      // A subscribed viewer can receive turn/started before the committed input.
      // Preserve the original turn order without duplicating optimistic input.
      const beforeAssistant = action.message.turnId && !state.some(m => m.id === action.message.id)
        ? state.findIndex(m => m.role === 'assistant' && m.turnId === action.message.turnId &&
            m.taskId === action.message.taskId)
        : -1
      const messages = [...state]
      messages.splice(beforeAssistant < 0 ? messages.length : beforeAssistant, 0, action.message)
      return normalizeUniqueWorkbenchMessages(messages).map(message =>
        limitWorkbenchMessage(message)
      )
    }
    case 'peer_added': {
      // Peer messages are committed at an engine boundary. Replays must not
      // split a later assistant segment a second time.
      if (state.some(message => message.id === action.message.id)) return state
      let activeIndex = -1
      for (let index = state.length - 1; index >= 0; index -= 1) {
        if (state[index].status === 'streaming' && isAssistantMessageForAction(state[index], action)) {
          activeIndex = index
          break
        }
      }
      const messages = state.map((message, index) => index === activeIndex
        ? { ...message, status: 'done' as const, streamSegmentClosed: true } : message)
      return [...messages, limitWorkbenchMessage(action.message)]
    }
    case 'assistant_started':
      if (state.some(message => isAssistantMessageForAction(message, action))) {
        return state.map(message =>
          isAssistantMessageForAction(message, action)
            ? limitWorkbenchMessage({
                ...clearMessageError(message),
                taskId: action.taskId ?? message.taskId,
                turnId: action.turnId ?? message.turnId,
                attemptId: action.attemptId ?? message.attemptId,
                shellType: action.shellType ?? message.shellType,
                ...(message.status === 'pending' && action.occurredAtMs !== undefined &&
                  { createdAt: new Date(action.occurredAtMs).toISOString() }),
                status: 'streaming' as const,
              })
            : message
        )
      }
      return [
        ...state,
        limitWorkbenchMessage(
          createAssistantMessage<TAttachment, TFileChanges>({
            messageId: nextAssistantMessageId(state, action),
            taskId: action.taskId,
            subtaskId: action.subtaskId,
            turnId: action.turnId,
            attemptId: action.attemptId,
            shellType: action.shellType,
            createdAt: action.occurredAtMs,
          })
        ),
      ]
    case 'assistant_cached':
      if (state.some(message => isAssistantMessageForAction(message, action))) {
        return state.map(message =>
          isAssistantMessageForAction(message, action)
            ? limitWorkbenchMessage({
                ...clearMessageError(message),
                taskId: action.taskId ?? message.taskId,
                content: action.content,
                status: 'streaming' as const,
                blocks: action.blocks ?? message.blocks,
              })
            : message
        )
      }
      return [
        ...state,
        limitWorkbenchMessage(
          createAssistantMessage<TAttachment, TFileChanges>({
            messageId: nextAssistantMessageId(state, action),
            taskId: action.taskId,
            subtaskId: action.subtaskId,
            content: action.content,
            blocks: action.blocks ?? [],
          })
        ),
      ]
    case 'assistant_item_phase': {
      const index = state.findLastIndex(message => message.role === 'assistant' &&
        (message.subtaskId === action.subtaskId || message.id === action.subtaskId))
      if (index < 0) return state
      const message = state[index]
      if (message.status !== 'streaming' && message.status !== 'pending') return state
      if (action.phase === 'thinking' && (message.status !== 'streaming' || message.latestModelActivity === 'thinking')) return state
      const next = state.slice()
      next[index] = action.phase === 'completed'
        ? { ...message, status: 'done' } : { ...message, latestModelActivity: 'thinking' }
      return next
    }
    case 'assistant_chunk':
      if (!state.some(message => isAssistantMessageForAction(message, action))) {
        const contentMerge = mergeWorkbenchChunkContent(
          '',
          undefined,
          undefined,
          action.content,
          action.offset,
          0
        )
        const previous = previousAssistantSegment(state, action)
        const message = createAssistantMessage<TAttachment, TFileChanges>({
          messageId: nextAssistantMessageId(state, action),
          taskId: previous?.taskId,
          subtaskId: action.subtaskId,
          turnId: previous?.turnId,
          attemptId: previous?.attemptId,
          shellType: previous?.shellType,
          content: contentMerge.content,
          createdAt: action.occurredAtMs,
        })
        return [
          ...state,
          limitWorkbenchMessage({
            ...message,
            streamTextOffset: contentMerge.streamTextOffset,
            latestModelActivity: action.content ? 'text' : action.reasoningChunk ? 'thinking' : undefined,
            blocks: getChunkBlocks(message, action),
          }),
        ]
      }
      return state.map(message => {
        if (!isAssistantMessageForAction(message, action) || message.status === 'done')
          return message
        const { contentChars, ...contentMerge } = mergeWorkbenchChunkContent(
          message.content,
          message.streamTextOffset,
          message.contentOriginalChars,
          action.content,
          action.offset,
          knownTextLength(message, message.content)
        )
        return limitWorkbenchMessage(
          {
            ...clearMessageError(message),
            ...contentMerge,
            latestModelActivity: action.content ? 'text' : action.reasoningChunk ? 'thinking' : message.latestModelActivity,
            status: 'streaming' as const,
            blocks: getChunkBlocks(message, action),
          },
          contentChars
        )
      })
    case 'assistant_done': {
      const targetIndex = findTerminalAssistantMessageIndex(state, action)
      if (targetIndex < 0) {
        return [
          ...state,
          limitWorkbenchMessage(
            createAssistantMessage<TAttachment, TFileChanges>({
              messageId: action.messageId,
              subtaskId: action.subtaskId,
              turnId: action.turnId,
              content: action.content ?? '',
              status: 'done',
              createdAt: action.occurredAtMs,
              completedAt: action.occurredAtMs,
              blocks: finalizeProcessingBlocks(action.blocks, 'done', action.occurredAtMs),
              fileChanges: action.fileChanges,
              fileChangesCapture: action.fileChangesCapture,
              reviewEvidence: action.reviewEvidence,
            })
          ),
        ]
      }
      return state.map((message, index) =>
        index === targetIndex
          ? limitWorkbenchMessage({
              ...clearMessageError(message),
              turnId: action.turnId ?? message.turnId,
              content: action.content ?? message.content,
              streamTextOffset: undefined,
              // A completed response is authoritative and cannot retain replaced streaming offsets or truncation metadata.
              ...(action.content !== undefined && {
                contentTruncated: undefined,
                contentOriginalChars: undefined,
                contentLoadRef: undefined,
              }),
              status: 'done' as const,
              ...(action.occurredAtMs !== undefined && { completedAt: action.occurredAtMs }),
              blocks: finalizeProcessingBlocks(action.blocks ?? message.blocks, 'done', action.occurredAtMs),
              fileChanges: action.fileChanges ?? message.fileChanges,
              fileChangesCapture: action.fileChangesCapture ?? message.fileChangesCapture,
              reviewEvidence: action.reviewEvidence ?? message.reviewEvidence,
            })
          : message
      )
    }
    case 'assistant_cancelled': {
      const completedAt = new Date(action.occurredAtMs ?? Date.now()).toISOString()
      const matches = state.some(message =>
        isAssistantMessageForCancellationAction(message, action)
      )
        ? (message: WorkbenchMessage<TAttachment, TFileChanges>) =>
            isAssistantMessageForCancellationAction(message, action)
        : (message: WorkbenchMessage<TAttachment, TFileChanges>) =>
            !action.messageId &&
            !action.subtaskId &&
            message.role === 'assistant' &&
            message.status === 'streaming'
      if (!state.some(matches)) {
        return [
          ...state,
          limitWorkbenchMessage(
            createAssistantMessage<TAttachment, TFileChanges>({
              messageId: nextAssistantMessageId(state, action),
              subtaskId: action.subtaskId,
              content: action.content ?? '',
              status: 'done',
              runtimeStatus: 'cancelled',
              createdAt: action.occurredAtMs,
              completedAt,
              stoppedNotice: true,
            })
          ),
        ]
      }
      return state.map(message =>
        matches(message)
          ? limitWorkbenchMessage({
              ...clearMessageError(message),
              content: action.content ?? message.content,
              ...(action.content !== undefined && {
                contentTruncated: undefined,
                contentOriginalChars: undefined,
                contentLoadRef: undefined,
              }),
              status: 'done' as const,
              runtimeStatus: 'cancelled' as const,
              completedAt,
              stoppedNotice: true,
              blocks: finalizeProcessingBlocks(message.blocks, 'done', action.occurredAtMs),
            })
          : message
      )
    }
    case 'review_evidence_updated': {
      const targetIndex = findTerminalAssistantMessageIndex(state, action)
      return state.map((message, index) => index === targetIndex ? { ...message, reviewEvidence: action.evidence } : message)
    }
    case 'file_capture_updated': {
      const targetIndex = findTerminalAssistantMessageIndex(state, action)
      return state.map((message, index) =>
        index === targetIndex ? { ...message, fileChangesCapture: action.capture } : message
      )
    }
    case 'file_changes_updated':
      return state.map(message =>
        isAssistantMessageForSubtask(message, action.subtaskId)
          ? { ...message, fileChanges: action.fileChanges }
          : message
      )
    case 'assistant_error': {
      const providerFailure = decodeProviderFailure(action.providerFailure)
      if (!state.some(message => isAssistantMessageForAction(message, action))) {
        return [
          ...state,
          limitWorkbenchMessage(
            createAssistantMessage<TAttachment, TFileChanges>({
              messageId: nextAssistantMessageId(state, action),
              subtaskId: action.subtaskId,
              status: 'failed',
              createdAt: action.occurredAtMs,
              completedAt: action.occurredAtMs,
              error: action.error,
              errorType: action.errorType,
              providerFailure,
              blocks: finalizeProcessingBlocks(undefined, 'error'),
            })
          ),
        ]
      }
      return state.map(message =>
        isAssistantMessageForAction(message, action)
          ? limitWorkbenchMessage({
              ...message,
              status: 'failed' as const,
              ...(action.occurredAtMs !== undefined && { completedAt: action.occurredAtMs }),
              error:
                message.error && isGenericTaskStatusError(action.error) && !providerFailure
                  ? message.error
                  : action.error,
              errorType:
                message.error && isGenericTaskStatusError(action.error) && !providerFailure
                  ? message.errorType
                  : action.errorType,
              blocks: finalizeProcessingBlocks(message.blocks, 'error', action.occurredAtMs),
              providerFailure:
                message.error && isGenericTaskStatusError(action.error) && !providerFailure
                  ? message.providerFailure
                  : providerFailure,
            })
          : message
      )
    }
    case 'block_created':
      if (!state.some(message => isAssistantMessageForAction(message, action))) {
        const previous = previousAssistantSegment(state, action)
        const message = createAssistantMessage<TAttachment, TFileChanges>({
          messageId: nextAssistantMessageId(state, action),
          taskId: previous?.taskId,
          subtaskId: action.subtaskId,
          turnId: previous?.turnId,
          attemptId: previous?.attemptId,
          shellType: previous?.shellType,
          createdAt: action.block.createdAt,
        })
        return [...state, limitWorkbenchMessage(createBlockCreatedMessage(message, action))]
      }
      return state.map(message =>
        isAssistantMessageForAction(message, action)
          ? limitWorkbenchMessage(createBlockCreatedMessage(message, action))
          : message
      )
    case 'block_updated':
      return state.map(message => {
        if (message.status === 'unknown') return message
        if (action.taskId && message.taskId && action.taskId !== message.taskId) return message
        if (action.turnId && message.turnId && action.turnId !== message.turnId) return message
        if (action.attemptId && message.attemptId && action.attemptId !== message.attemptId)
          return message
        const matchesStreamIdentity = isAssistantMessageForAction(message, action)
        const containsStableBlock = (message.blocks ?? []).some(
          block => block.id === action.blockId
        )
        // Transcript reset changes subtaskId to a history cursor while tool-call IDs
        // remain stable within the task. A late background terminal event must update
        // every same-ID copy and cannot be dropped because history identity changed.
        if (!matchesStreamIdentity && !containsStableBlock) return message
        const existing = (message.blocks ?? []).find(block => block.id === action.blockId)
        if (existing && !canAcceptToolCallUpdate(existing.status, action.updates.status))
          return message
        return limitWorkbenchMessage({
          ...withActiveStreamState(
            message,
            matchesStreamIdentity && isActiveBlockStatus(action.updates.status)
          ),
          blocks: (message.blocks ?? []).map(block =>
            block.id === action.blockId ? mergeProcessingBlockUpdate(block, action.updates) : block
          ),
        })
      })
    default:
      return state
  }
}

function mergeProcessingBlockUpdate<TFileChanges>(
  block: WorkbenchProcessingBlock<TFileChanges>,
  updates: ProcessingBlockUpdate
): WorkbenchProcessingBlock<TFileChanges> {
  if (!canAcceptToolCallUpdate(block.status, updates.status)) return block
  const { toolOutputDelta, ...directUpdates } = updates
  if (
    block.type === 'tool' &&
    block.status === updates.status &&
    !isActiveToolCallStatus(block.status) &&
    isOmittedImageReplay(block.toolOutput, updates.toolOutput)
  ) {
    // A compact resume receipt cannot erase the same call's hydrated images.
    delete directUpdates.toolOutput
  }
  const nextBlock = withBlockCompletionTime(block, {
    ...block,
    ...directUpdates,
  } as WorkbenchProcessingBlock<TFileChanges>)

  if (typeof toolOutputDelta !== 'string' || block.type !== 'tool') {
    return nextBlock
  }

  const nextToolBlock = nextBlock as WorkbenchToolBlock
  const previousOutput = nextToolBlock.toolOutput
  const nextToolOutput = appendToolOutputDelta(previousOutput, toolOutputDelta)
  const previousOutputChars =
    typeof previousOutput === 'string'
      ? knownTextLength(block, previousOutput)
      : previousOutput === undefined || previousOutput === null
        ? 0
        : textCodePointLength(String(previousOutput))
  const deltaChars = textCodePointLength(toolOutputDelta)
  const knownOriginalChars =
    nextToolBlock.toolOutputOriginalChars ?? nextToolBlock.toolOutputOriginalBytes
  const nextOriginalChars =
    knownOriginalChars !== undefined && knownOriginalChars > previousOutputChars
      ? knownOriginalChars + deltaChars
      : previousOutputChars + deltaChars
  const appended = {
    ...nextToolBlock,
    toolOutput: nextToolOutput,
    toolOutputOriginalChars: nextOriginalChars,
  }
  if (typeof nextToolOutput === 'string')
    rememberTextLength(appended, nextToolOutput, previousOutputChars + deltaChars)
  return appended
}

function isOmittedImageReplay(previous: unknown, incoming: unknown): boolean {
  if (!previous || typeof previous !== 'object' || !incoming || typeof incoming !== 'object')
    return false
  const before = previous as Record<string, unknown>
  const after = incoming as Record<string, unknown>
  return (
    Array.isArray(before.images) &&
    before.images.length > 0 &&
    after.imagesOmitted === true &&
    Array.isArray(after.images) &&
    after.images.length === 0
  )
}

function limitWorkbenchMessage<TAttachment, TFileChanges>(
  message: WorkbenchMessage<TAttachment, TFileChanges>,
  /** Visible code points of `message.content`, when the caller already knows them. */
  contentChars?: number
): WorkbenchMessage<TAttachment, TFileChanges> {
  if (message.role !== 'assistant') {
    return message
  }

  const content = limitTextContent(
    message.content,
    MAX_LIVE_MESSAGE_CONTENT_CHARS,
    message.contentOriginalChars,
    contentChars ?? knownTextLength(message, message.content)
  )
  const blocks = sortProcessingBlocksByCreatedAt(message.blocks?.map(limitProcessingBlock))
  const limited = {
    ...message,
    content: content.text,
    contentTruncated: content.truncated || undefined,
    contentOriginalChars: content.truncated ? content.originalChars : undefined,
    contentLoadRef: content.truncated ? messageContentLoadRef(message) : undefined,
    blocks,
  }
  rememberTextLength(limited, content.text, content.textChars)
  return limited
}

function limitProcessingBlock<TFileChanges>(
  block: WorkbenchProcessingBlock<TFileChanges>
): WorkbenchProcessingBlock<TFileChanges> {
  if (block.type === 'tool') {
    return limitToolBlock(block) as WorkbenchProcessingBlock<TFileChanges>
  }
  if (block.type === 'thinking' || block.type === 'text' || block.type === 'plan') {
    const content = limitTextContent(
      block.content,
      MAX_LIVE_BLOCK_CONTENT_CHARS,
      block.contentOriginalChars,
      knownTextLength(block, block.content)
    )
    const limited = {
      ...block,
      content: content.text,
      contentTruncated: content.truncated || undefined,
      contentOriginalChars: content.truncated ? content.originalChars : undefined,
      contentLoadRef: content.truncated ? blockContentLoadRef(block) : undefined,
    }
    rememberTextLength(limited, content.text, content.textChars)
    return limited
  }
  return block
}

function sortProcessingBlocksByCreatedAt<TFileChanges>(
  blocks: WorkbenchProcessingBlock<TFileChanges>[] | undefined
): WorkbenchProcessingBlock<TFileChanges>[] | undefined {
  if (!blocks) return undefined

  return blocks
    .map((block, index) => ({ block, index }))
    .sort((left, right) => {
      const leftCreatedAt = Number.isFinite(left.block.createdAt)
        ? left.block.createdAt
        : Number.POSITIVE_INFINITY
      const rightCreatedAt = Number.isFinite(right.block.createdAt)
        ? right.block.createdAt
        : Number.POSITIVE_INFINITY
      if (leftCreatedAt === rightCreatedAt) {
        return left.index - right.index
      }
      return leftCreatedAt - rightCreatedAt
    })
    .map(({ block }) => block)
}

function limitToolBlock(block: WorkbenchToolBlock): WorkbenchToolBlock {
  const measured = block
  if (Object.hasOwn(block, 'generatedLineProgress')) {
    const progress = isActiveToolCallStatus(block.status)
      ? normalizeGeneratedLineProgress(block.generatedLineProgress)
      : undefined
    if (progress) block = { ...block, generatedLineProgress: progress }
    else {
      const { generatedLineProgress, ...settled } = block
      void generatedLineProgress
      block = settled
    }
  }
  if (typeof block.toolOutput !== 'string') return block

  const output = limitTextContent(
    block.toolOutput,
    MAX_LIVE_TOOL_OUTPUT_CHARS,
    block.toolOutputOriginalChars ?? block.toolOutputOriginalBytes,
    knownTextLength(measured, block.toolOutput)
  )
  const limited = {
    ...block,
    toolOutput: output.text,
    toolOutputTruncated: output.truncated || block.toolOutputTruncated || undefined,
    toolOutputOriginalBytes: output.truncated
      ? output.originalChars
      : block.toolOutputOriginalBytes,
    toolOutputOriginalChars: output.truncated
      ? output.originalChars
      : block.toolOutputOriginalChars,
    toolOutputLoadRef: output.truncated ? toolOutputLoadRef(block) : block.toolOutputLoadRef,
  }
  rememberTextLength(limited, output.text, output.textChars)
  return limited
}

function limitTextContent(
  value: string,
  maxChars: number,
  knownOriginalChars?: number,
  /** Visible code points of `value`, when already known. */
  valueChars?: number
): { text: string; truncated: boolean; originalChars: number; textChars: number } {
  const currentChars = valueChars ?? textCodePointLength(value)
  const originalChars = Math.max(knownOriginalChars ?? currentChars, currentChars)
  if (currentChars <= maxChars) {
    return {
      text: value,
      truncated: originalChars > maxChars && originalChars > currentChars,
      originalChars,
      textChars: currentChars,
    }
  }

  return {
    text: sliceTextCodePoints(value, currentChars - maxChars, currentChars),
    truncated: true,
    originalChars,
    textChars: maxChars,
  }
}

function messageContentLoadRef<TAttachment, TFileChanges>(
  message: WorkbenchMessage<TAttachment, TFileChanges>
): WorkbenchContentLoadRef {
  return {
    taskId: message.taskId,
    messageId: message.id,
    subtaskId: message.subtaskId,
    kind: 'message_content',
  }
}

function blockContentLoadRef(block: BaseWorkbenchProcessingBlock): WorkbenchContentLoadRef {
  return {
    subtaskId: block.subtaskId,
    blockId: block.id,
    kind: 'block_content',
  }
}

function toolOutputLoadRef(block: WorkbenchToolBlock): WorkbenchContentLoadRef {
  return {
    subtaskId: block.subtaskId,
    blockId: block.id,
    kind: 'tool_output',
  }
}

function appendToolOutputDelta(current: unknown, delta: string): unknown {
  if (typeof current === 'string' || typeof current === 'undefined' || current === null) {
    return `${current ?? ''}${delta}`
  }

  return `${String(current)}${delta}`
}

function normalizeUniqueWorkbenchMessages<TAttachment, TFileChanges>(
  messages: WorkbenchMessage<TAttachment, TFileChanges>[]
): WorkbenchMessage<TAttachment, TFileChanges>[] {
  const normalized: WorkbenchMessage<TAttachment, TFileChanges>[] = []
  const indexes = new Map<string, number>()

  for (const message of messages) {
    const index = indexes.get(message.id)
    if (index === undefined) {
      indexes.set(message.id, normalized.length)
      normalized.push(message)
      continue
    }

    console.warn('[KCoder Studio] Duplicate workbench message id merged', {
      messageId: message.id,
      role: message.role,
      subtaskId: message.subtaskId ?? null,
      existingRole: normalized[index].role,
      existingSubtaskId: normalized[index].subtaskId ?? null,
    })
    normalized[index] = mergeDuplicateWorkbenchMessage(normalized[index], message)
  }

  return normalized
}

function mergeDuplicateWorkbenchMessage<TAttachment, TFileChanges>(
  current: WorkbenchMessage<TAttachment, TFileChanges>,
  incoming: WorkbenchMessage<TAttachment, TFileChanges>
): WorkbenchMessage<TAttachment, TFileChanges> {
  return {
    ...current,
    ...incoming,
    taskId: incoming.taskId ?? current.taskId,
    subtaskId: incoming.subtaskId ?? current.subtaskId,
    shellType: incoming.shellType ?? current.shellType,
    content: mergeMessageContent(current.content, incoming.content),
    attachments: incoming.attachments ?? current.attachments,
    blocks: mergeMessageBlocks(current.blocks, incoming.blocks),
    fileChanges: incoming.fileChanges ?? current.fileChanges,
    fileChangesCapture: incoming.fileChangesCapture ?? current.fileChangesCapture,
    reviewEvidence: incoming.reviewEvidence ?? current.reviewEvidence,
    source: incoming.source ?? current.source,
    runtimeStatus: incoming.runtimeStatus ?? current.runtimeStatus,
    completedAt: incoming.completedAt ?? current.completedAt,
    stoppedNotice: incoming.stoppedNotice ?? current.stoppedNotice,
    createdAt: current.createdAt || incoming.createdAt,
  }
}

function mergeMessageContent(current: string, incoming: string): string {
  if (!incoming) return current
  if (!current) return incoming
  if (current === incoming) return current
  if (incoming.startsWith(current)) return incoming
  if (current.startsWith(incoming)) return current
  return `${current}${incoming}`
}

function mergeMessageBlocks<TFileChanges>(
  current: WorkbenchProcessingBlock<TFileChanges>[] | undefined,
  incoming: WorkbenchProcessingBlock<TFileChanges>[] | undefined
): WorkbenchProcessingBlock<TFileChanges>[] | undefined {
  if (!incoming) return current
  return incoming.reduce(mergeProcessingBlock, current ?? [])
}

function isAssistantMessageForAction<TAttachment, TFileChanges>(
  message: WorkbenchMessage<TAttachment, TFileChanges>,
  action: { messageId?: string; subtaskId?: string }
): boolean {
  if (message.role !== 'assistant') return false
  if (action.messageId) return message.id === action.messageId
  if (message.streamSegmentClosed) return false
  return typeof action.subtaskId === 'string' && message.subtaskId === action.subtaskId
}

function previousAssistantSegment<TAttachment, TFileChanges>(
  state: WorkbenchMessage<TAttachment, TFileChanges>[],
  action: { subtaskId?: string }
): WorkbenchMessage<TAttachment, TFileChanges> | undefined {
  if (!action.subtaskId) return undefined
  return [...state].reverse().find(message => message.role === 'assistant' &&
    message.subtaskId === action.subtaskId && message.streamSegmentClosed)
}

function nextAssistantMessageId<TAttachment, TFileChanges>(
  state: WorkbenchMessage<TAttachment, TFileChanges>[],
  action: { messageId?: string; subtaskId?: string }
): string | undefined {
  if (action.messageId || !previousAssistantSegment(state, action)) return action.messageId
  const base = `assistant-${action.subtaskId}-segment-`
  let number = 1
  while (state.some(message => message.id === `${base}${number}`)) number += 1
  return `${base}${number}`
}

function findTerminalAssistantMessageIndex<TAttachment, TFileChanges>(
  messages: WorkbenchMessage<TAttachment, TFileChanges>[],
  action: { messageId?: string; subtaskId?: string }
): number {
  if (action.messageId) {
    return messages.findIndex(
      message => message.role === 'assistant' && message.id === action.messageId
    )
  }
  if (typeof action.subtaskId !== 'string') return -1

  // Match live-stream identity first. When transcript history uses another identity,
  // select the final assistant item in the same turn. Select exactly one target so a
  // terminal event cannot overwrite several body segments from one turn.
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index]
    if (message?.role === 'assistant' && message.subtaskId === action.subtaskId) return index
  }
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index]
    if (message?.role === 'assistant' && message.turnId === action.subtaskId) return index
  }
  return -1
}

function isAssistantMessageForCancellationAction<TAttachment, TFileChanges>(
  message: WorkbenchMessage<TAttachment, TFileChanges>,
  action: { messageId?: string; subtaskId?: string }
): boolean {
  if (message.role !== 'assistant') return false
  if (message.streamSegmentClosed) return false
  if (
    typeof action.subtaskId === 'string' &&
    (message.subtaskId === action.subtaskId ||
      message.attemptId === action.subtaskId ||
      (!message.attemptId && message.turnId === action.subtaskId))
  )
    return true
  return Boolean(action.messageId && message.id === action.messageId)
}

function isAssistantMessageForSubtask<TAttachment, TFileChanges>(
  message: WorkbenchMessage<TAttachment, TFileChanges>,
  subtaskId: string
): boolean {
  return message.role === 'assistant' && message.subtaskId === subtaskId
}

function createAssistantMessage<TAttachment, TFileChanges>({
  messageId,
  taskId,
  subtaskId,
  turnId,
  attemptId,
  shellType,
  content = '',
  status = 'streaming',
  blocks = [],
  fileChanges,
  fileChangesCapture,
  reviewEvidence,
  error,
  errorType,
  providerFailure,
  runtimeStatus,
  completedAt,
  createdAt,
  stoppedNotice,
}: {
  messageId?: string
  taskId?: string
  subtaskId?: string
  turnId?: string
  attemptId?: string
  shellType?: string
  content?: string
  status?: WorkbenchMessageStatus
  blocks?: WorkbenchProcessingBlock<TFileChanges>[]
  fileChanges?: TFileChanges
  fileChangesCapture?: unknown
  reviewEvidence?: unknown
  error?: string
  errorType?: string
  providerFailure?: ProviderFailureDetails
  runtimeStatus?: WorkbenchRuntimeMessageStatus | null
  completedAt?: string | number | null
  createdAt?: number
  stoppedNotice?: boolean | null
}): WorkbenchMessage<TAttachment, TFileChanges> {
  return {
    id: messageId ?? `assistant-${subtaskId ?? Date.now()}`,
    taskId,
    subtaskId,
    turnId,
    attemptId,
    shellType,
    role: 'assistant',
    content,
    status,
    blocks,
    fileChanges,
    fileChangesCapture,
    reviewEvidence,
    error,
    errorType,
    providerFailure,
    runtimeStatus,
    completedAt,
    stoppedNotice,
    createdAt: new Date(createdAt ?? Date.now()).toISOString(),
  }
}

function clearMessageError<TAttachment, TFileChanges>(
  message: WorkbenchMessage<TAttachment, TFileChanges>
): WorkbenchMessage<TAttachment, TFileChanges> {
  if (!message.error && !message.errorType && !message.providerFailure) return message

  const messageWithoutError = { ...message }
  delete messageWithoutError.error
  delete messageWithoutError.errorType
  delete messageWithoutError.providerFailure
  return messageWithoutError
}

function withActiveStreamState<TAttachment, TFileChanges>(
  message: WorkbenchMessage<TAttachment, TFileChanges>,
  isActive: boolean
): WorkbenchMessage<TAttachment, TFileChanges> {
  if (!isActive) return message

  return {
    ...clearMessageError(message),
    status: 'streaming',
  }
}

function isActiveBlockStatus(status?: WorkbenchToolBlockStatus): boolean {
  return isActiveToolCallStatus(status)
}

function createBlockCreatedMessage<TAttachment, TFileChanges>(
  message: WorkbenchMessage<TAttachment, TFileChanges>,
  action: Extract<WorkbenchMessageAction<TAttachment, TFileChanges>, { type: 'block_created' }>
): WorkbenchMessage<TAttachment, TFileChanges> {
  const subtaskId = action.subtaskId ?? message.subtaskId
  const movesPendingContent = shouldMovePendingContentBeforeBlock(message, action.block)
  const existing = message.blocks?.find(block => block.id === action.block.id)
  if (existing && !canAcceptToolCallUpdate(existing.status, action.block.status)) return message
  const activeMessage = withActiveStreamState(message, isActiveBlockStatus(action.block.status))
  return {
    ...activeMessage,
    ...(action.block.type === 'thinking' && action.block.status === 'streaming' && {
      latestModelActivity: 'thinking' as const,
    }),
    content: movesPendingContent ? '' : message.content,
    ...(movesPendingContent && {
      streamTextOffset: undefined,
      contentTruncated: undefined,
      contentOriginalChars: undefined,
      contentLoadRef: undefined,
    }),
    blocks: mergeProcessingBlock(
      subtaskId
        ? getBlocksBeforeIncomingBlock(message, subtaskId, action.block)
        : (message.blocks ?? []),
      action.block
    ),
  }
}

export function normalizeWorkbenchBlockStatus(status?: string): WorkbenchToolBlockStatus {
  return decodeToolCallStatus(status).status
}

function getChunkBlocks<TAttachment, TFileChanges>(
  message: WorkbenchMessage<TAttachment, TFileChanges>,
  action: Extract<WorkbenchMessageAction<TAttachment, TFileChanges>, { type: 'assistant_chunk' }>
) {
  const withReasoning = appendThinkingChunk(
    message.blocks,
    action.subtaskId ?? message.subtaskId,
    action.reasoningChunk,
    action.occurredAtMs
  )

  const withNarrative = action.content
    ? finalizeBlocks(withReasoning, undefined, action.occurredAtMs) : withReasoning
  if (!action.blocks) return withNarrative
  return action.blocks.reduce(mergeProcessingBlock, withNarrative ?? [])
}

function mergeWorkbenchChunkContent(
  content: string,
  streamTextOffset: number | undefined,
  contentOriginalChars: number | undefined,
  incomingContent: string,
  incomingOffset: number | undefined,
  /** Visible code points of `content`; streaming keeps it current without rescanning. */
  contentChars: number
): {
  content: string
  streamTextOffset?: number
  contentOriginalChars?: number
  /** Visible code points of the returned `content`. */
  contentChars: number
} {
  if (!incomingContent) {
    return { content, streamTextOffset, contentOriginalChars, contentChars }
  }

  const currentOffset =
    streamTextOffset ?? (content.length === 0 && incomingOffset === 0 ? 0 : undefined)
  if (
    incomingOffset === undefined ||
    currentOffset === undefined ||
    incomingOffset > currentOffset
  ) {
    const incomingLength = textCodePointLength(incomingContent)
    return {
      content: content + incomingContent,
      streamTextOffset: incomingOffset === undefined ? undefined : incomingOffset + incomingLength,
      contentChars: contentChars + incomingLength,
      contentOriginalChars: nextMergedOriginalChars(
        contentChars,
        contentOriginalChars,
        incomingLength,
        incomingOffset,
        incomingLength
      ),
    }
  }

  const incomingLength = textCodePointLength(incomingContent)
  if (incomingOffset < currentOffset) {
    const coveredLength = currentOffset - incomingOffset
    if (coveredLength >= incomingLength) {
      return {
        content,
        streamTextOffset: currentOffset,
        contentChars,
        contentOriginalChars: nextMergedOriginalChars(
          contentChars,
          contentOriginalChars,
          0,
          incomingOffset,
          incomingLength
        ),
      }
    }

    const suffix = sliceTextCodePoints(incomingContent, coveredLength, incomingLength)
    const suffixLength = incomingLength - coveredLength
    return {
      content: content + suffix,
      streamTextOffset: incomingOffset + incomingLength,
      contentChars: contentChars + suffixLength,
      contentOriginalChars: nextMergedOriginalChars(
        contentChars,
        contentOriginalChars,
        suffixLength,
        incomingOffset,
        incomingLength
      ),
    }
  }

  return {
    content: content + incomingContent,
    streamTextOffset: incomingOffset + incomingLength,
    contentChars: contentChars + incomingLength,
    contentOriginalChars: nextMergedOriginalChars(
      contentChars,
      contentOriginalChars,
      incomingLength,
      incomingOffset,
      incomingLength
    ),
  }
}

function nextMergedOriginalChars(
  currentVisibleChars: number,
  currentOriginalChars: number | undefined,
  appendedChars: number,
  incomingOffset: number | undefined,
  incomingLength: number
): number {
  const localOriginalChars =
    currentOriginalChars !== undefined && currentOriginalChars > currentVisibleChars
      ? currentOriginalChars + appendedChars
      : currentVisibleChars + appendedChars
  const offsetOriginalChars = incomingOffset === undefined ? 0 : incomingOffset + incomingLength
  return Math.max(localOriginalChars, offsetOriginalChars)
}

/**
 * Visible code-point lengths of already measured immutable text, keyed by the message
 * or block that owns it. Streaming appends then cost O(chunk) instead of O(content).
 */
const measuredTextLengths = new WeakMap<object, { text: string; chars: number }>()

function knownTextLength(owner: object, text: string): number {
  const known = measuredTextLengths.get(owner)
  // Same-reference strings compare in O(1); a replaced value is measured again.
  if (known && known.text === text) return known.chars
  const chars = textCodePointLength(text)
  measuredTextLengths.set(owner, { text, chars })
  return chars
}

function rememberTextLength(owner: object, text: string, chars: number) {
  measuredTextLengths.set(owner, { text, chars })
}

function textCodePointLength(value: string): number {
  return isAscii(value) ? value.length : Array.from(value).length
}

function sliceTextCodePoints(value: string, start: number, length: number): string {
  if (start <= 0) return value
  if (length === value.length) return value.slice(start)
  // In a full streaming window, only the newly appended prefix length is discarded.
  let offset = 0
  for (let point = 0; point < start; point++) {
    offset += value.codePointAt(offset)! > 0xffff ? 2 : 1
  }
  return value.slice(offset)
}

function isAscii(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    if (value.charCodeAt(index) > 0x7f) return false
  }
  return true
}

function appendThinkingChunk<TFileChanges>(
  blocks: WorkbenchProcessingBlock<TFileChanges>[] | undefined,
  subtaskId: string | undefined,
  chunk?: string,
  occurredAtMs?: number
): WorkbenchProcessingBlock<TFileChanges>[] | undefined {
  if (!chunk) return blocks
  if (!subtaskId) return blocks

  const nextBlocks = [...(blocks ?? [])]
  const lastBlock = nextBlocks[nextBlocks.length - 1]
  if (lastBlock?.type === 'thinking' && lastBlock.status === 'streaming') {
    const previousChars = knownTextLength(lastBlock, lastBlock.content)
    const deltaChars = textCodePointLength(chunk)
    const content = lastBlock.content + chunk
    const appended = {
      ...lastBlock,
      content,
      contentOriginalChars: Math.max(lastBlock.contentOriginalChars ?? 0, previousChars) + deltaChars,
    }
    rememberTextLength(appended, content, previousChars + deltaChars)
    nextBlocks[nextBlocks.length - 1] = appended
    return nextBlocks
  }

  const thinkingCount = nextBlocks.filter(block => block.type === 'thinking').length
  return [
    ...nextBlocks,
    {
      id: `thinking-${subtaskId}-${thinkingCount + 1}`,
      subtaskId,
      type: 'thinking',
      content: chunk,
      status: 'streaming',
      createdAt: occurredAtMs ?? Date.now(),
    },
  ]
}

function getBlocksBeforeIncomingBlock<TAttachment, TFileChanges>(
  message: WorkbenchMessage<TAttachment, TFileChanges>,
  subtaskId: string,
  incomingBlock: WorkbenchProcessingBlock<TFileChanges>
): WorkbenchProcessingBlock<TFileChanges>[] {
  const finalizedBlocks = finalizeOpenNarrativeBlocks(message.blocks, incomingBlock.createdAt)
  if (!shouldMovePendingContentBeforeBlock(message, incomingBlock)) return finalizedBlocks

  return [
    ...finalizedBlocks,
    {
      id: `text-${subtaskId}-${getTextBlockCount(finalizedBlocks) + 1}`,
      subtaskId,
      type: 'text',
      content: message.content,
      status: 'done',
      createdAt: incomingBlock.createdAt,
    },
  ]
}

function shouldMovePendingContentBeforeBlock<TAttachment, TFileChanges>(
  message: WorkbenchMessage<TAttachment, TFileChanges>,
  incomingBlock: WorkbenchProcessingBlock<TFileChanges>
): boolean {
  return incomingBlock.type !== 'text' && message.content.trim().length > 0
}

function getTextBlockCount(blocks: WorkbenchProcessingBlock[]): number {
  return blocks.filter(block => block.type === 'text').length
}

function finalizeOpenNarrativeBlocks<TFileChanges>(
  blocks: WorkbenchProcessingBlock<TFileChanges>[] | undefined,
  nextBlockCreatedAt: number
): WorkbenchProcessingBlock<TFileChanges>[] {
  return (blocks ?? []).map(block => {
    if (
      (block.type === 'thinking' || block.type === 'text' || block.type === 'plan') &&
      block.status === 'streaming'
    ) {
      return {
        ...block,
        status: 'done' as const,
        createdAt: Math.min(block.createdAt, nextBlockCreatedAt),
        completedAt: block.completedAt ?? Date.now(),
      }
    }

    return block
  })
}

function finalizeBlocks<TFileChanges>(
  blocks: WorkbenchProcessingBlock<TFileChanges>[] | undefined,
  finalStatus?: Extract<WorkbenchToolBlockStatus, 'done' | 'error'>,
  occurredAtMs?: number
): WorkbenchProcessingBlock<TFileChanges>[] {
  return (blocks ?? []).map(block => {
    if (block.type === 'thinking' && block.status === 'streaming') {
      return { ...block, status: 'done' as const, ...(occurredAtMs !== undefined && { completedAt: occurredAtMs }) }
    }

    if (
      !finalStatus ||
      block.status === 'done' ||
      block.status === 'error' ||
      block.status === 'unknown'
    ) {
      return block
    }

    return withBlockCompletionTime(block, {
      ...block,
      status: finalStatus,
      ...(occurredAtMs !== undefined && { completedAt: occurredAtMs }),
    } as WorkbenchProcessingBlock<TFileChanges>)
  })
}

function finalizeProcessingBlocks<TFileChanges>(
  blocks: WorkbenchProcessingBlock<TFileChanges>[] | undefined,
  finalStatus: Extract<WorkbenchToolBlockStatus, 'done' | 'error'> = 'done',
  occurredAtMs?: number
): WorkbenchProcessingBlock<TFileChanges>[] | undefined {
  if (!blocks) return undefined
  return finalizeBlocks(blocks, finalStatus, occurredAtMs)
}

function mergeProcessingBlock<TFileChanges>(
  blocks: WorkbenchProcessingBlock<TFileChanges>[],
  incomingBlock: WorkbenchProcessingBlock<TFileChanges>
): WorkbenchProcessingBlock<TFileChanges>[] {
  const index = blocks.findIndex(block => block.id === incomingBlock.id)
  if (index === -1) return [...blocks, incomingBlock]
  if (!canAcceptToolCallUpdate(blocks[index].status, incomingBlock.status)) return blocks

  const nextBlocks = [...blocks]
  nextBlocks[index] = withBlockCompletionTime(nextBlocks[index], {
    ...nextBlocks[index],
    ...incomingBlock,
  } as WorkbenchProcessingBlock<TFileChanges>)
  return nextBlocks
}

function withBlockCompletionTime<TFileChanges>(
  previous: WorkbenchProcessingBlock<TFileChanges>,
  next: WorkbenchProcessingBlock<TFileChanges>
): WorkbenchProcessingBlock<TFileChanges> {
  const wasActive = isActiveToolCallStatus(previous.status)
  const isComplete = next.status === 'done' || next.status === 'error'
  if (!wasActive || !isComplete || next.completedAt !== undefined) return next
  return { ...next, completedAt: Date.now() }
}
