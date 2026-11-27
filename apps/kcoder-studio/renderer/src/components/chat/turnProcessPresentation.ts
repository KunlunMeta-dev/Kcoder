import { isActiveToolCallStatus } from '@wegent/chat-core'
import type { ProcessingBlock, WorkbenchMessage } from '@/types/workbench'
import {
  isPendingRequestUserInputBlock,
  isRequestUserInputBlock,
} from './requestUserInputMessages'
import { isContextCompactionToolName, isGuidanceToolName } from './blocks/toolBlockKinds'

export type TurnProcessStatus =
  | 'running'
  | 'waiting'
  | 'pending'
  | 'completed'
  | 'failed'
  | 'unknown'
  | 'stopped'

export interface TurnProcessPresentation {
  key: string
  ownerMessageId: string
  finalMessageId?: string
  status: TurnProcessStatus
  canUseSummary: boolean
  canGroupActivity?: boolean
  canCollapse: boolean
  hasThinking: boolean
  hasTools: boolean
  blocks: ProcessingBlock[]
  describing?: boolean
  startedAt?: number
  completedAt?: number
  terminalOutcome?: 'stopped' | 'failed' | 'unknown'
  terminalAt?: number
}

interface ProcessMessage {
  message: WorkbenchMessage
  blocks: ProcessingBlock[]
}

interface ProcessSegment {
  identity: string
  messages: WorkbenchMessage[]
  processMessages: ProcessMessage[]
}

export function buildTurnProcessPresentations(
  messages: WorkbenchMessage[],
  conversationKey: string | number | null | undefined,
  isWaitingForAssistant: boolean,
  processingWindowEnabled: boolean,
  processRunId?: string
): Map<string, TurnProcessPresentation> {
  const presentations = new Map<string, TurnProcessPresentation>()

  let current: ProcessSegment | null = null
  const finishSegment = (waiting = false) => {
    const segment = current
    current = null
    if (!segment || !segment.processMessages.length &&
      segment.messages.filter(message => message.status === 'failed').length < 2) {
      return
    }

    const presentation = createPresentation(segment, conversationKey, waiting, processRunId)
    if (processingWindowEnabled) {
      presentation.canGroupActivity = false
      presentation.canUseSummary = false
      presentation.canCollapse = false
    }
    for (const message of segment.messages) {
      presentations.set(message.id, presentation)
    }
  }

  messages.forEach(message => {
    const identity = getMessageIdentity(message, processRunId)
    if (!identity) {
      finishSegment()
      return
    }

    if (current && current.identity !== identity) finishSegment()
    if (!current) current = { identity, messages: [], processMessages: [] }

    current.messages.push(message)
    const blocks = getVisibleProcessBlocks(message.blocks)
    if (blocks.length > 0) current.processMessages.push({ message, blocks })
  })

  finishSegment(isWaitingForAssistant)
  return presentations
}

function createPresentation(
  segment: ProcessSegment,
  conversationKey: string | number | null | undefined,
  isWaitingForAssistant: boolean,
  processRunId?: string
): TurnProcessPresentation {
  const processMessages = segment.processMessages
  const blocks = processMessages.flatMap(item => item.blocks)
  const first = processMessages[0]?.message ?? segment.messages[0]
  const terminal = segment.messages.findLast(message =>
    message.runtimeStatus === 'cancelled' || message.status === 'failed' || message.status === 'unknown'
  )
  const terminalOutcome = terminal?.runtimeStatus === 'cancelled' ? 'stopped'
    : terminal?.status === 'failed' ? 'failed'
      : terminal?.status === 'unknown' ? 'unknown' : undefined
  const terminalAt = terminal ? asTimestamp(terminal.completedAt) ??
    (terminal.runtimeStatus === 'cancelled' ? asTimestamp(terminal.createdAt) : undefined) : undefined
  const needsUserAction = blocks.some(
    block =>
      block.type === 'plan' ||
      (isRequestUserInputBlock(block) && isPendingRequestUserInputBlock(block))
  )
  const hasActiveBlock = blocks.some(block => isActiveToolCallStatus(block.status))
  const hasUnknownBlock = blocks.some(block => block.status === 'unknown')
  const hasUnsupportedBlock = blocks.some(
    block =>
      block.type === 'tool' &&
      (isGuidanceToolName(block.toolName) || isContextCompactionToolName(block.toolName))
  )
  const hasFailedMessage = segment.messages.some(
    message => message.status === 'failed' || Boolean(message.error)
  )
  const hasUnknownMessage = segment.messages.some(message => message.status === 'unknown')
  const hasStableIdentity = Boolean(processRunId || first.turnId && first.attemptId)
  const hasPendingMessage = segment.messages.some(message => message.status === 'pending')
  const hasStoppedMessage = segment.messages.some(message => message.runtimeStatus === 'cancelled')
  const isRunning =
    isWaitingForAssistant ||
    segment.messages.some(message => message.status === 'streaming') ||
    hasActiveBlock
  const status: TurnProcessStatus = hasFailedMessage
    ? 'failed'
    : hasStoppedMessage
      ? 'stopped'
      : needsUserAction
        ? 'waiting'
        : hasUnknownMessage || hasUnknownBlock
          ? 'unknown'
          : hasPendingMessage
            ? 'pending'
            : isRunning
              ? 'running'
              : 'completed'
  const canGroupActivity =
    !blocks.some(block => block.type === 'plan') &&
    !hasUnsupportedBlock &&
    !segment.messages.some(
      message => message.runtimeGuidanceSplitBefore || message.runtimeGuidanceContinuation
    ) &&
    status !== 'pending'
  const canUseSummary = hasStableIdentity && canGroupActivity
  const canCollapse =
    canUseSummary &&
    (Boolean(terminalOutcome) ||
      (!isRunning && !hasPendingMessage && segment.messages.every(message => message.status === 'done')))
  const timestamps = getTimestamps(segment.messages, blocks)
  const visibleMessages = segment.messages.filter(message => message.content.trim() || message.error || message.status === 'failed' ||
    message.status === 'unknown' || message.runtimeStatus === 'cancelled' ||
    getVisibleProcessBlocks(message.blocks).length > 0)
  const ownerId = visibleMessages[0].id
  // Only a settled successful attempt has a final tail. Earlier text belongs to its process.
  const tail = visibleMessages.at(-1)
  const liveMessage = segment.messages.findLast(message => message.status === 'streaming')
  const finalMessageId = canCollapse && !terminalOutcome && !hasFailedMessage && !hasUnknownMessage && tail?.status === 'done' &&
    !tail.streamSegmentClosed && tail.content.trim() ? tail.id : undefined
  const turnId = first.turnId ?? null
  const attemptId = first.attemptId ?? null
  const conversationId = conversationKey == null ? 'default' : String(conversationKey)

  return {
    key: processRunId
      ? JSON.stringify([conversationId, 'subagent-process', processRunId, segment.identity, ownerId])
      : JSON.stringify([conversationId, 'turn-process', turnId, attemptId, ownerId]),
    ownerMessageId: ownerId,
    ...(finalMessageId ? { finalMessageId } : {}),
    status,
    canUseSummary,
    canGroupActivity,
    canCollapse,
    hasThinking: blocks.some(block => block.type === 'thinking' || block.type === 'text'),
    hasTools: blocks.some(block => block.type !== 'thinking' && block.type !== 'text'),
    blocks,
    describing: liveMessage?.latestModelActivity !== 'thinking' && Boolean(liveMessage?.content.trim()),
    ...(terminalOutcome ? { terminalOutcome } : {}),
    ...(terminalAt !== undefined ? { terminalAt } : {}),
    ...timestamps,
  }
}

/** Separate live and settled choices so completion folds synchronously, before mounting rows. */
export function turnProcessDisclosureKey(presentation: TurnProcessPresentation): string {
  return `${presentation.key}:${presentation.canCollapse ? 'settled' : 'live'}`
}

/** A terminal attempt cannot keep a tool running; missing receipts remain unknown. */
export function projectTerminalProcessBlocks(
  blocks: ProcessingBlock[] | undefined,
  presentation?: TurnProcessPresentation
): ProcessingBlock[] | undefined {
  if (!blocks || !presentation?.terminalOutcome) return blocks
  const terminalAt = presentation.terminalAt
  return blocks.map(block => {
    const active = isActiveToolCallStatus(block.status)
    const needsEnd = (active || block.status === 'unknown') && block.completedAt === undefined &&
      terminalAt !== undefined
    if (!active && !needsEnd) return block
    return {
      ...block,
      ...(active ? block.type === 'tool' || block.type === 'file_changes'
        ? { status: 'unknown' as const, rawStatus: 'result_unrecorded' }
        : { status: 'done' as const } : {}),
      ...(needsEnd ? { completedAt: Math.max(block.createdAt, terminalAt) } : {}),
    }
  })
}

function getMessageIdentity(message: WorkbenchMessage, processRunId?: string): string | null {
  if (message.role !== 'assistant' || message.peerAgent !== undefined) return null
  if (!message.turnId || !message.attemptId)
    return processRunId ? JSON.stringify(['subagent-run', processRunId]) : `message:${message.id}`
  return JSON.stringify([message.turnId, message.attemptId])
}

function getVisibleProcessBlocks(blocks: ProcessingBlock[] | undefined): ProcessingBlock[] {
  return (blocks ?? []).filter(block => {
    if (block.type !== 'text' && block.type !== 'thinking') return true
    return Boolean(block.content.trim())
  })
}

function getTimestamps(messages: WorkbenchMessage[], blocks: ProcessingBlock[]): {
  startedAt?: number
  completedAt?: number
} {
  let startedAt: number | undefined
  let completedAt: number | undefined
  for (const item of [...messages, ...blocks]) {
    const start = asTimestamp(item.createdAt)
    const end = asTimestamp(item.completedAt)
    if (start !== undefined) startedAt = Math.min(startedAt ?? start, start)
    if (end !== undefined) completedAt = Math.max(completedAt ?? end, end)
  }
  return {
    ...(startedAt !== undefined ? { startedAt } : {}),
    ...(completedAt !== undefined && completedAt >= (startedAt ?? 0) ? { completedAt } : {}),
  }
}

function asTimestamp(value: string | number | null | undefined): number | undefined {
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) return undefined
    if (value > 1_000_000_000_000) return value
    if (value > 1_000_000_000) return value * 1000
    return undefined
  }
  if (typeof value !== 'string' || !value.trim()) return undefined
  const numericValue = Number(value)
  if (Number.isFinite(numericValue)) return asTimestamp(numericValue)
  const timestamp = new Date(value).getTime()
  return Number.isFinite(timestamp) ? timestamp : undefined
}
