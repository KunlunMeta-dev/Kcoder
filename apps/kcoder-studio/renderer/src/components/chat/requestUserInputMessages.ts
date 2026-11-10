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

function questionSourceIdentity(source: RequestUserInputPayload['sourceAgent']) {
  if (!source) return null
  return [
    source.parentSessionId,
    source.agentId,
    source.backgroundRun
      ? [
          source.backgroundRun.parentSessionId,
          source.backgroundRun.agentId,
          source.backgroundRun.runId,
        ]
      : null,
  ]
}

function questionIdentityKey(
  kind: 'request' | 'item',
  id: string,
  source: RequestUserInputPayload['sourceAgent']
): string {
  // Transport IDs can be reused by independent workers and later runs. Keep
  // their presentation keys separate from the legacy parent-task namespace.
  return source
    ? `${kind}@source:${JSON.stringify([questionSourceIdentity(source), id])}`
    : `${kind}:${id}`
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
    keys.push(questionIdentityKey('request', String(requestId), payload?.sourceAgent))
  }

  const itemId = payload?.itemId ?? payload?.item_id
  if (itemId !== undefined && itemId !== null && String(itemId).trim()) {
    keys.push(questionIdentityKey('item', String(itemId), payload?.sourceAgent))
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
    keys.push(questionIdentityKey('request', String(requestId), response.sourceAgent))
  }

  const itemId = response.itemId ?? response.item_id
  if (itemId !== undefined && itemId !== null && String(itemId).trim()) {
    keys.push(questionIdentityKey('item', String(itemId), response.sourceAgent))
  }

  return keys
}

export function isImplementationPlanRequestUserInput(
  payload: RequestUserInputPayload | null | undefined
): boolean {
  if (payload?.allowImplementationPlanShortcut === false) return false
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

export function requestUserInputBlockKey(block: ProcessingBlock | undefined): string {
  if (!block || !isRequestUserInputBlock(block)) return block?.id ?? 'empty'
  const keys = requestUserInputPayloadKeys(block.renderPayload)
  if (keys.length === 0) return block.id
  const { threadId, turnId, appServerEpoch } = block.renderPayload
  // Recovery can rebuild presentation block IDs for the same original question.
  return `question:${JSON.stringify([threadId, turnId, appServerEpoch, keys])}`
}

export function isPendingRequestUserInputBlock(
  block: ProcessingBlock,
  hiddenRequestUserInputIds: ReadonlySet<string> = EMPTY_HIDDEN_REQUEST_USER_INPUT_IDS
): block is RequestUserInputBlock {
  if (!isRequestUserInputBlock(block)) return false
  if (block.status === 'error' || block.renderPayload.resolved === true) return false
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
  return matchesRequestUserInputKeys(
    requestUserInputPayloadKeys(block.renderPayload),
    hiddenRequestUserInputIds
  )
}

export function insertUserMessageBeforeRequestUserInput(
  messages: WorkbenchMessage[],
  userMessage: WorkbenchMessage,
  response: RequestUserInputResponse
): WorkbenchMessage[] {
  if (requestUserInputRelatedKeys(messages, response).length === 0) return [...messages, userMessage]
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
  const responseKeys = new Set(requestUserInputResponseKeys(response))
  const overlappingKeys = payloads.map(requestUserInputPayloadKeys).filter(keys =>
    keys.some(key => responseKeys.has(key))
  )
  const relatedKeys = new Set(responseKeys)
  for (const key of [...relatedKeys]) {
    const aliases = aliasesByKey.get(key) ?? []
    // A reused ID cannot import an old alias group that contradicts another
    // explicit response identity. Same-question restoration aliases still agree.
    if ([...aliases].some(alias => [...responseKeys].some(original =>
      original.startsWith(alias.slice(0, alias.indexOf(':') + 1)) &&
      original !== alias && !aliasesByKey.get(original)?.has(alias)))) continue
    for (const alias of aliases) relatedKeys.add(alias)
  }
  const matchingKeys = overlappingKeys.filter(keys => matchesRequestUserInputKeys(keys, relatedKeys))
  // A partial legacy projection cannot certify contradictory identities.
  // Keep complete matches and registered restoration aliases authoritative,
  // while preserving partial-only legacy projections without a known conflict.
  if (
    matchingKeys.length !== overlappingKeys.length &&
    !matchingKeys.some(keys => keys.length === responseKeys.size &&
      keys.every(key => responseKeys.has(key)))
  )
    return []
  // A partial response cannot choose between different complete bindings that
  // reuse its only ID. Duplicate projections and known restoration aliases
  // still describe the same original interaction.
  const matchedByKind = new Map<string, string>()
  for (const keys of matchingKeys) {
    for (const key of keys) {
      const kind = key.slice(0, key.indexOf(':') + 1)
      const previous = matchedByKind.get(kind)
      if (
        previous &&
        previous !== key &&
        !aliasesByKey.get(previous)?.has(key) &&
        !aliasesByKey.get(key)?.has(previous)
      )
        return []
      matchedByKind.set(kind, key)
    }
  }
  const matchingPayloads = payloads.filter(payload =>
    matchesRequestUserInputKeys(requestUserInputPayloadKeys(payload), relatedKeys))
  // Request/item IDs can be reused after a turn or server restart. Neither an
  // explicit stale response nor an ambiguous legacy one may settle these cards.
  // Include restored aliases in the check; omitted legacy locators still agree.
  if ((['threadId', 'turnId', 'appServerEpoch'] as const).some(field =>
    new Set([response[field], ...matchingPayloads.map(payload => payload[field])]
      .filter(value => value != null)).size > 1)) return []
  // Retain the exact identity of the current payload. Do not correlate by question text, which could merge two independent identical requests.
  for (const payload of matchingPayloads) {
    for (const key of requestUserInputPayloadKeys(payload)) relatedKeys.add(key)
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
  const observedPayloads = [...tracker.previousPayloads, ...currentPayloads]
  // A completed historical question cannot be a restoration of a later prompt.
  // Fence every projection of its identity, including the previous unanswered
  // copy when the response first appears in the current snapshot.
  const answeredBindings = observedPayloads.filter(hasRequestUserInputResponse)
    .map(payload => new Set(requestUserInputPayloadKeys(payload)))
  const canAlias = (payload: RequestUserInputPayload) =>
    !answeredBindings.some(binding =>
      matchesRequestUserInputKeys(requestUserInputPayloadKeys(payload), binding))
  const signatures = new Set(
    observedPayloads
      .map(requestUserInputQuestionsSignature)
      .filter((value): value is string => Boolean(value))
  )
  const observedBindings = uniquePayloadsByKey(observedPayloads)
  const currentBindings = uniquePayloadsByKey(currentPayloads)
  for (const signature of signatures) {
    const candidates = observedBindings.filter(
      payload =>
        canAlias(payload) &&
        requestUserInputQuestionsSignature(payload) === signature &&
        !hasRequestIdentifier(payload) &&
        !payloadHasKnownAlias(payload, tracker.aliasesByKey)
    )
    const livePayloads = currentBindings.filter(
      payload =>
        canAlias(payload) &&
        requestUserInputQuestionsSignature(payload) === signature &&
        hasRequestIdentifier(payload) &&
        !payloadHasKnownAlias(payload, tracker.aliasesByKey)
    )
    // Stable item identities reserve their own slots before positional rebasing.
    // A reordered or partial live snapshot cannot alias an unrelated sibling.
    const unmatchedCandidates = candidates.filter(candidate => {
      const binding = new Set(requestUserInputPayloadKeys(candidate))
      const matches = livePayloads.filter(payload =>
        matchesRequestUserInputKeys(requestUserInputPayloadKeys(payload), binding))
      if (matches.length === 1) linkPayloadAliases(tracker.aliasesByKey, candidate, matches[0])
      return matches.length === 0
    })
    const unmatchedLivePayloads = livePayloads.filter(payload =>
      !candidates.some(candidate => matchesRequestUserInputKeys(
        requestUserInputPayloadKeys(payload), new Set(requestUserInputPayloadKeys(candidate)))))
    // A partial snapshot cannot identify which identical sibling was rebased.
    // Stable matches above remain valid; positional recovery needs every slot.
    if (unmatchedCandidates.length !== unmatchedLivePayloads.length) continue
    for (let index = 0; index < unmatchedCandidates.length; index += 1) {
      linkPayloadAliases(tracker.aliasesByKey, unmatchedCandidates[index], unmatchedLivePayloads[index])
    }
  }
  tracker.previousPayloads = currentPayloads
}

export function applyRequestUserInputResponseToMessages(
  messages: WorkbenchMessage[],
  response: RequestUserInputResponse
): WorkbenchMessage[] {
  if (requestUserInputRelatedKeys(messages, response).length === 0) return messages
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
  if (responseKeys.size === 0) return false
  return matchesRequestUserInputKeys(requestUserInputPayloadKeys(block.renderPayload), responseKeys)
}

function matchesRequestUserInputKeys(
  payloadKeys: string[],
  responseKeys: ReadonlySet<string>
): boolean {
  if (!payloadKeys.some(key => responseKeys.has(key))) return false
  // Missing legacy identities are allowed; identities present on both sides
  // must agree. A matching request ID cannot override a conflicting item ID.
  return payloadKeys.every(key => {
    const prefix = key.slice(0, key.indexOf(':') + 1)
    return (
      ![...responseKeys].some(candidate => candidate.startsWith(prefix)) || responseKeys.has(key)
    )
  })
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
  const unique = payloads.filter(payload => {
    const keys = requestUserInputPayloadKeys(payload)
    if (keys.length === 0) return false
    // Duplicate projections share the complete binding, not just a transport ID.
    const key = JSON.stringify(keys)
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
  // A request-only projection and its uniquely identified complete projection
  // occupy one restoration slot. Upgrade at the first occurrence to preserve
  // ordering even when a sibling appears before the complete projection.
  return [...new Set(unique.map(payload => {
    // Historical item-only cards still need their own restoration slots.
    if (!hasRequestIdentifier(payload)) return payload
    const keys = requestUserInputPayloadKeys(payload)
    const complete = unique.filter(candidate => {
      const candidateKeys = requestUserInputPayloadKeys(candidate)
      return candidateKeys.length > keys.length && keys.every(key => candidateKeys.includes(key)) &&
        requestUserInputQuestionsSignature(candidate) === requestUserInputQuestionsSignature(payload)
    })
    return complete.length === 1 ? complete[0] : payload
  }))]
}

function linkPayloadAliases(
  aliasesByKey: Map<string, ReadonlySet<string>>,
  left: RequestUserInputPayload,
  right: RequestUserInputPayload
) {
  // Identical prompts cannot bridge explicit task, turn or server lifetimes.
  // Omitted legacy locators may still recover their original live request.
  if ((['threadId', 'turnId', 'appServerEpoch'] as const).some(field =>
    left[field] != null && right[field] != null && left[field] !== right[field])) return
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
  return JSON.stringify([
    questionSourceIdentity(payload.sourceAgent),
    payload.questions.map(question => ({
      id: question.id ?? '',
      header: question.header ?? '',
      question: question.question ?? '',
      multiSelect: question.multiSelect ?? question.multi_select ?? false,
      // Identical labels can belong to different answer choices or input rules.
      // Preserve those semantics when pairing reordered recovery projections.
      allowCustom: Boolean(question.is_other ?? question.isOther ?? true),
      options: (question.options ?? []).map(option => ({
        id: option.id ?? '',
        label: option.label ?? '',
        description: option.description ?? '',
      })),
    })),
  ])
}
