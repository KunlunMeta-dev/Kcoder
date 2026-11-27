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
  id: string | number,
  source: RequestUserInputPayload['sourceAgent']
): string {
  // Preserve JSON request ID types; 1 and "1" name different waiters.
  // Transport IDs can be reused by independent workers and later runs. Keep
  // their presentation keys separate from the legacy parent-task namespace.
  return source
    ? `${kind}@source:${JSON.stringify([questionSourceIdentity(source), id])}`
    : `${kind}:${kind === 'request' ? JSON.stringify(id) : id}`
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
    keys.push(questionIdentityKey('request', requestId, payload?.sourceAgent))
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
    keys.push(questionIdentityKey('request', requestId, response.sourceAgent))
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
  // A transport ID can be reused after a turn or app-server restart. Cached
  // settlements retain their original lifetime, including restoration aliases.
  const payload = block.renderPayload
  const matchingIds = new Set<string>()
  for (const entry of hiddenRequestUserInputIds) {
    if (!entry.startsWith('settled:')) {
      matchingIds.add(entry)
      continue
    }
    const [binding, key] = JSON.parse(entry.slice('settled:'.length)) as [
      Array<string | null>, string,
    ]
    if (!(['threadId', 'turnId', 'appServerEpoch'] as const).some((field, index) =>
      binding[index] != null && payload[field] != null && binding[index] !== payload[field]))
      matchingIds.add(key)
  }
  return matchesRequestUserInputKeys(
    requestUserInputPayloadKeys(payload),
    matchingIds
  )
}

export function requestUserInputSettledKeysForPayloads(
  payloads: RequestUserInputPayload[],
  response: RequestUserInputResponse,
  aliasesByKey: ReadonlyMap<string, ReadonlySet<string>>
): string[] {
  const keys = requestUserInputRelatedKeysForPayloads(payloads, response, aliasesByKey)
  const binding = [response.threadId, response.turnId, response.appServerEpoch]
  // Keep the existing legacy behavior when the host supplied no locators.
  return binding.every(value => value == null) ? keys
    : keys.map(key => `settled:${JSON.stringify([binding, key])}`)
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
  // A restarted server may reuse transport/item IDs from settled history. An
  // explicit current binding can exclude those terminal copies, but pending
  // copies and replies missing the distinguishing locator stay ambiguous.
  const relevantPayloads = payloads.filter(payload =>
    !(payload.resolved === true || hasRequestUserInputResponse(payload)) ||
    !(['threadId', 'turnId', 'appServerEpoch'] as const).some(field =>
      payload[field] != null && response[field] != null && payload[field] !== response[field]))
  const responseKeys = new Set(requestUserInputResponseKeys(response))
  const overlappingKeys = relevantPayloads.map(requestUserInputPayloadKeys).filter(keys =>
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
  const matchingPayloads = relevantPayloads.filter(payload =>
    matchesRequestUserInputKeys(requestUserInputPayloadKeys(payload), relatedKeys))
  // Excluding old history cannot certify a reply whose current card is absent.
  if (!matchingPayloads.length && relevantPayloads.length !== payloads.length) return []
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

interface QuestionAliasBinding {
  payload: RequestUserInputPayload
  keys: string[]
  keySet: ReadonlySet<string>
  signature: string | null
}

export function observeRequestUserInputAliases(
  tracker: RequestUserInputAliasTracker,
  currentPayloads: RequestUserInputPayload[]
) {
  const observed = [...tracker.previousPayloads, ...currentPayloads].map(payload => {
    const keys = requestUserInputPayloadKeys(payload)
    return { payload, keys, keySet: new Set(keys), signature: requestUserInputQuestionsSignature(payload) }
  })
  const current = observed.slice(tracker.previousPayloads.length)
  // A terminal historical question cannot be a restoration of a later prompt.
  // Fence every projection of its identity, including the previous unanswered
  // copy when the response first appears in the current snapshot.
  const terminalBindings = observed.filter(({ payload }) =>
    payload.resolved === true || hasRequestUserInputResponse(payload))
  const canAlias = (binding: QuestionAliasBinding) =>
    !terminalBindings.some(terminal =>
      matchesRequestUserInputKeys(binding.keys, terminal.keySet) &&
      !(['threadId', 'turnId', 'appServerEpoch'] as const).some(field =>
        terminal.payload[field] != null && binding.payload[field] != null &&
        terminal.payload[field] !== binding.payload[field]))
  const signatures = new Set(observed.map(binding => binding.signature)
    .filter((value): value is string => Boolean(value)))
  // Reused IDs from ended lifetimes cannot take a current restoration slot.
  // Filter before deduplication so an older terminal copy cannot shadow it.
  const observedBindings = uniqueQuestionBindings(observed.filter(canAlias))
  const currentBindings = uniqueQuestionBindings(current.filter(canAlias))
  for (const signature of signatures) {
    const candidates = observedBindings.filter(binding => binding.signature === signature &&
      !hasRequestIdentifier(binding.payload) && !bindingHasKnownAlias(binding, tracker.aliasesByKey))
    const liveBindings = currentBindings.filter(binding => binding.signature === signature &&
      hasRequestIdentifier(binding.payload) && !bindingHasKnownAlias(binding, tracker.aliasesByKey))
    // Stable item identities reserve their own slots before positional rebasing.
    // A reordered or partial live snapshot cannot alias an unrelated sibling.
    const unmatchedCandidates = candidates.filter(candidate => {
      const matches = liveBindings.filter(binding => matchesRequestUserInputKeys(binding.keys, candidate.keySet))
      if (matches.length === 1) linkQuestionAliases(tracker.aliasesByKey, candidate, matches[0])
      return matches.length === 0
    })
    const unmatchedLiveBindings = liveBindings.filter(binding =>
      !candidates.some(candidate => matchesRequestUserInputKeys(binding.keys, candidate.keySet)))
    // A partial snapshot cannot identify which identical sibling was rebased.
    // Stable matches above remain valid; positional recovery needs every slot.
    if (unmatchedCandidates.length !== unmatchedLiveBindings.length) continue
    for (let index = 0; index < unmatchedCandidates.length; index += 1) {
      linkQuestionAliases(tracker.aliasesByKey, unmatchedCandidates[index], unmatchedLiveBindings[index])
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

function bindingHasKnownAlias(
  binding: QuestionAliasBinding,
  aliasesByKey: ReadonlyMap<string, ReadonlySet<string>>
): boolean {
  return binding.keys.some(key => aliasesByKey.has(key))
}

function uniqueQuestionBindings(bindings: QuestionAliasBinding[]): QuestionAliasBinding[] {
  const seen = new Set<string>()
  const unique = bindings.filter(binding => {
    if (binding.keys.length === 0) return false
    // Duplicate projections share the complete binding, not just a transport ID.
    const key = JSON.stringify(binding.keys)
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
  // A request-only projection and its uniquely identified complete projection
  // occupy one restoration slot. Upgrade at the first occurrence to preserve
  // ordering even when a sibling appears before the complete projection.
  return [...new Set(unique.map(binding => {
    // Historical item-only cards still need their own restoration slots.
    if (!hasRequestIdentifier(binding.payload)) return binding
    const complete = unique.filter(candidate =>
      candidate.keys.length > binding.keys.length && binding.keys.every(key => candidate.keySet.has(key)) &&
      candidate.signature === binding.signature)
    return complete.length === 1 ? complete[0] : binding
  }))]
}

function linkQuestionAliases(
  aliasesByKey: Map<string, ReadonlySet<string>>,
  left: QuestionAliasBinding,
  right: QuestionAliasBinding
) {
  // Identical prompts cannot bridge explicit task, turn or server lifetimes.
  // Omitted legacy locators may still recover their original live request.
  if ((['threadId', 'turnId', 'appServerEpoch'] as const).some(field =>
    left.payload[field] != null && right.payload[field] != null &&
    left.payload[field] !== right.payload[field])) return
  const keys = new Set([...left.keys, ...right.keys])
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
        label: option.label ?? option.value ?? '',
        value: option.value ?? option.label ?? '',
        description: option.description ?? '',
      })),
    })),
  ])
}
