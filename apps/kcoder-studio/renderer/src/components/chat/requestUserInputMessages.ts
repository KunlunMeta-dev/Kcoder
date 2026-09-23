import type { RequestUserInputResponse } from '@/types/api'
import type { ProcessingBlock, ToolBlock, WorkbenchMessage } from '@/types/workbench'
import type { RequestUserInputPayload } from './RequestUserInputCard'

const EMPTY_HIDDEN_REQUEST_USER_INPUT_IDS = new Set<string>()
export const CODEX_IMPLEMENT_PLAN_QUESTION = '执行此计划?'
export const CODEX_IMPLEMENT_PLAN_RESPONSE_LABEL = '是的，执行此计划'
const IMPLEMENT_PLAN_TEXT_MARKERS = ['实施此计划', '执行此计划']

export function hasImplementationPlanText(text: string | null | undefined): boolean {
  const normalizedText = text?.trim()
  return Boolean(
    normalizedText && IMPLEMENT_PLAN_TEXT_MARKERS.some(marker => normalizedText.includes(marker))
  )
}

export type RequestUserInputBlock = ToolBlock & {
  renderPayload: RequestUserInputPayload
}

export function requestUserInputPayloadKey(
  payload: RequestUserInputPayload | null | undefined
): string | null {
  return requestUserInputPayloadKeys(payload)[0] ?? null
}

export function requestUserInputPayloadKeys(
  payload: RequestUserInputPayload | null | undefined
): string[] {
  const keys: string[] = []
  const requestId = payload?.requestId ?? payload?.request_id
  if (requestId !== undefined && requestId !== null && String(requestId).trim()) {
    keys.push(`request:${String(requestId)}`)
  }

  const itemId = payload?.itemId ?? payload?.item_id
  if (itemId !== undefined && itemId !== null && String(itemId).trim()) {
    keys.push(`item:${String(itemId)}`)
  }

  return keys
}

export function requestUserInputResponseKey(response: RequestUserInputResponse): string | null {
  return requestUserInputResponseKeys(response)[0] ?? null
}

export function requestUserInputResponseKeys(response: RequestUserInputResponse): string[] {
  const keys: string[] = []
  const requestId = response.requestId ?? response.request_id
  if (requestId !== undefined && requestId !== null && String(requestId).trim()) {
    keys.push(`request:${String(requestId)}`)
  }

  const itemId = response.itemId ?? response.item_id
  if (itemId !== undefined && itemId !== null && String(itemId).trim()) {
    keys.push(`item:${String(itemId)}`)
  }

  return keys
}

export function isImplementationPlanRequestUserInput(
  payload: RequestUserInputPayload | null | undefined
): boolean {
  const questions = Array.isArray(payload?.questions) ? payload.questions : []
  return questions.some(question => {
    const id = question.id?.trim().toLowerCase()
    const text = question.question?.trim()
    if (id === 'implement') return true
    if (hasImplementationPlanText(text)) return true
    return question.options?.some(option => hasImplementationPlanText(option.label)) ?? false
  })
}

export function isImplementationPlanConfirmationResponse(
  response: RequestUserInputResponse | null | undefined
): boolean {
  const answers = response?.answers
  if (!answers || typeof answers !== 'object') return false

  return Object.values(answers).some(answer => {
    if (!answer || typeof answer !== 'object') return false
    const values = (answer as { answers?: unknown }).answers
    if (!Array.isArray(values)) return false
    return values.some(value => hasImplementationPlanText(String(value)))
  })
}

export function isRequestUserInputBlock(block: ProcessingBlock): block is RequestUserInputBlock {
  if (block.type !== 'tool') return false
  return isRequestUserInputPayload(block.renderPayload)
}

export function isPendingRequestUserInputBlock(
  block: ProcessingBlock,
  hiddenRequestUserInputIds: ReadonlySet<string> = EMPTY_HIDDEN_REQUEST_USER_INPUT_IDS
): block is RequestUserInputBlock {
  if (!isRequestUserInputBlock(block)) return false
  if (block.status === 'error') return false
  if (hasRequestUserInputResponse(block.renderPayload)) return false
  return !isHiddenRequestUserInputBlock(block, hiddenRequestUserInputIds)
}

export function isAnsweredRequestUserInputBlock(block: ProcessingBlock): boolean {
  if (!isRequestUserInputBlock(block)) return false
  return hasRequestUserInputResponse(block.renderPayload)
}

export function isHiddenRequestUserInputBlock(
  block: ProcessingBlock,
  hiddenRequestUserInputIds: ReadonlySet<string>
): boolean {
  if (!isRequestUserInputBlock(block)) return false
  return requestUserInputPayloadKeys(block.renderPayload).some(key =>
    hiddenRequestUserInputIds.has(key)
  )
}

export function insertUserMessageBeforeRequestUserInput(
  messages: WorkbenchMessage[],
  userMessage: WorkbenchMessage,
  response: RequestUserInputResponse
): WorkbenchMessage[] {
  const responseKeys = new Set(requestUserInputResponseKeys(response))
  const targetIndex = findRequestUserInputMessageIndex(messages, responseKeys)
  if (targetIndex < 0) {
    return [...messages, userMessage]
  }

  return [...messages.slice(0, targetIndex), userMessage, ...messages.slice(targetIndex)]
}

export function requestUserInputRelatedKeys(
  messages: WorkbenchMessage[],
  response: RequestUserInputResponse
): string[] {
  const payloads = messages.flatMap(message =>
    (message.blocks ?? []).filter(isRequestUserInputBlock).map(block => block.renderPayload)
  )
  return requestUserInputRelatedKeysForPayloads(payloads, response)
}

export function requestUserInputRelatedKeysForPayloads(
  payloads: RequestUserInputPayload[],
  response: RequestUserInputResponse,
  aliasesByKey: ReadonlyMap<string, ReadonlySet<string>> = new Map()
): string[] {
  const relatedKeys = new Set(requestUserInputResponseKeys(response))
  for (const key of [...relatedKeys]) {
    for (const alias of aliasesByKey.get(key) ?? []) relatedKeys.add(alias)
  }
  // Retain the exact identity of the current payload. Do not correlate by question text, which could merge two independent identical requests.
  for (const payload of payloads) {
    const payloadKeys = requestUserInputPayloadKeys(payload)
    if (!payloadKeys.some(key => relatedKeys.has(key))) continue
    for (const key of payloadKeys) relatedKeys.add(key)
  }
  return [...relatedKeys]
}

export interface RequestUserInputAliasTracker {
  previousPayloads: RequestUserInputPayload[]
  aliasesByKey: Map<string, ReadonlySet<string>>
}

export function createRequestUserInputAliasTracker(): RequestUserInputAliasTracker {
  return { previousPayloads: [], aliasesByKey: new Map() }
}

export function observeRequestUserInputAliases(
  tracker: RequestUserInputAliasTracker,
  currentPayloads: RequestUserInputPayload[]
) {
  const signatures = new Set(
    [...tracker.previousPayloads, ...currentPayloads]
      .map(requestUserInputQuestionsSignature)
      .filter((value): value is string => Boolean(value))
  )
  for (const signature of signatures) {
    const candidates = uniquePayloadsByKey([
      ...tracker.previousPayloads,
      ...currentPayloads,
    ]).filter(
      payload =>
        requestUserInputQuestionsSignature(payload) === signature &&
        !hasRequestIdentifier(payload) &&
        !payloadHasKnownAlias(payload, tracker.aliasesByKey)
    )
    const livePayloads = currentPayloads.filter(
      payload =>
        requestUserInputQuestionsSignature(payload) === signature &&
        hasRequestIdentifier(payload) &&
        !payloadHasKnownAlias(payload, tracker.aliasesByKey)
    )
    const pairCount = Math.min(candidates.length, livePayloads.length)
    for (let index = 0; index < pairCount; index += 1) {
      linkPayloadAliases(tracker.aliasesByKey, candidates[index], livePayloads[index])
    }
  }
  tracker.previousPayloads = currentPayloads
}

export function applyRequestUserInputResponseToMessages(
  messages: WorkbenchMessage[],
  response: RequestUserInputResponse
): WorkbenchMessage[] {
  const responseKeys = new Set(requestUserInputResponseKeys(response))
  let didUpdate = false

  const nextMessages = messages.map(message => {
    if (message.role !== 'assistant' || !message.blocks?.length) return message

    let messageUpdated = false
    const nextBlocks = message.blocks.map(block => {
      if (!isMatchingRequestUserInputBlock(block, responseKeys)) return block
      didUpdate = true
      messageUpdated = true
      return {
        ...block,
        status: 'done' as const,
        renderPayload: {
          ...block.renderPayload,
          response,
        },
      }
    })

    return messageUpdated ? { ...message, blocks: nextBlocks } : message
  })

  return didUpdate ? nextMessages : messages
}

function isRequestUserInputPayload(value: unknown): value is RequestUserInputPayload {
  return (
    Boolean(value) &&
    typeof value === 'object' &&
    !Array.isArray(value) &&
    (value as { kind?: unknown }).kind === 'request_user_input'
  )
}

export function hasRequestUserInputResponse(payload: RequestUserInputPayload): boolean {
  return Boolean(
    payload.response ?? payload.requestUserInputResponse ?? payload.request_user_input_response
  )
}

function findRequestUserInputMessageIndex(
  messages: WorkbenchMessage[],
  responseKeys: ReadonlySet<string>
): number {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index]
    if (message.role !== 'assistant') continue
    if (!message.blocks?.some(block => isMatchingRequestUserInputBlock(block, responseKeys))) {
      continue
    }
    return index
  }
  return -1
}

function isMatchingRequestUserInputBlock(
  block: ProcessingBlock,
  responseKeys: ReadonlySet<string>
): block is RequestUserInputBlock {
  if (!isPendingRequestUserInputBlock(block)) return false
  if (responseKeys.size === 0) return true
  return requestUserInputPayloadKeys(block.renderPayload).some(key => responseKeys.has(key))
}

function hasRequestIdentifier(payload: RequestUserInputPayload): boolean {
  const requestId = payload.requestId ?? payload.request_id
  return requestId !== undefined && requestId !== null && String(requestId).trim().length > 0
}

function payloadHasKnownAlias(
  payload: RequestUserInputPayload,
  aliasesByKey: ReadonlyMap<string, ReadonlySet<string>>
): boolean {
  return requestUserInputPayloadKeys(payload).some(key => aliasesByKey.has(key))
}

function uniquePayloadsByKey(payloads: RequestUserInputPayload[]): RequestUserInputPayload[] {
  const seen = new Set<string>()
  return payloads.filter(payload => {
    const key = requestUserInputPayloadKey(payload)
    if (!key || seen.has(key)) return false
    seen.add(key)
    return true
  })
}

function linkPayloadAliases(
  aliasesByKey: Map<string, ReadonlySet<string>>,
  left: RequestUserInputPayload,
  right: RequestUserInputPayload
) {
  const keys = new Set([
    ...requestUserInputPayloadKeys(left),
    ...requestUserInputPayloadKeys(right),
  ])
  for (const key of keys) {
    const aliases = new Set(keys)
    aliases.delete(key)
    aliasesByKey.set(key, aliases)
  }
}

function requestUserInputQuestionsSignature(payload: RequestUserInputPayload): string | null {
  if (!payload.questions?.length) return null
  return JSON.stringify(
    payload.questions.map(question => ({
      id: question.id ?? '',
      header: question.header ?? '',
      question: question.question ?? '',
      multiSelect: question.multiSelect ?? question.multi_select ?? false,
      options: (question.options ?? []).map(option => ({
        label: option.label ?? '',
        description: option.description ?? '',
      })),
    }))
  )
}
