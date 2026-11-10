import {
  isWidgetInputPreview,
  type WidgetInputPreview as PreviewContract,
} from '../../../shared/generated/contracts'

export interface WidgetInputPreview extends Omit<PreviewContract, 'title'> {
  toolCallId: string
  threadId: string
  turnId: string
  attemptId: string
  title?: string
}
interface Scope {
  clientToken: number
  instance: string
  sequence: number
  activeAttempt: string
  active: boolean
  previews: WidgetInputPreview[]
}
interface Identity {
  deviceId: string
  taskId: string
  threadId: string
  turnId: string
  attemptId: string
  client: object
  serverId: unknown
  sequence: unknown
}
const scopes = new Map<string, Scope>()
const clientTokens = new WeakMap<object, number>()
let nextClientToken = 0
function clientToken(client: object) {
  let token = clientTokens.get(client)
  if (token === undefined) {
    token = ++nextClientToken
    clientTokens.set(client, token)
  }
  return token
}
const listeners = new Set<
  (deviceId: string, taskId: string, previews: WidgetInputPreview[]) => void
>()
const key = (deviceId: string, taskId: string) => `${deviceId}\0${taskId}`
const object = (value: unknown): Record<string, unknown> =>
  value && typeof value === 'object' ? (value as Record<string, unknown>) : {}

export function readWidgetPreviews(deviceId: string, taskId: string): WidgetInputPreview[] {
  return scopes.get(key(deviceId, taskId))?.previews ?? []
}
export function subscribeWidgetPreviews(
  listener: (deviceId: string, taskId: string, previews: WidgetInputPreview[]) => void
) {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

/** Callers have already checked the actual current task client and accepted attempt. */
export function acceptWidgetPreviewNotification(
  identity: Identity,
  method: string,
  rawEvent?: unknown
): void {
  const event = object(rawEvent)
  const begin = method === 'turn/started'
  const terminal = method === 'turn/completed'
  const reset =
    method === 'item/event' &&
    (event.type === 'tool_input_reset' ||
      (event.type === 'system_notice' && event.kind === 'provider_retry'))
  const preview = method === 'item/event' && event.type === 'widget_input_preview'
  if (!begin && !terminal && !reset && !preview) return
  if (
    typeof identity.serverId !== 'string' ||
    !Number.isSafeInteger(identity.sequence) ||
    Number(identity.sequence) < 0 ||
    !identity.attemptId
  )
    return
  const scopeKey = key(identity.deviceId, identity.taskId)
  const token = clientToken(identity.client)
  let scope = scopes.get(scopeKey)
  if (!scope || scope.clientToken !== token || scope.instance !== identity.serverId) {
    if (!begin && !preview) return
    scope = {
      clientToken: token,
      instance: identity.serverId,
      sequence: -1,
      activeAttempt: identity.attemptId,
      active: true,
      previews: [],
    }
    scopes.set(scopeKey, scope)
    if (scopes.size > 128) scopes.delete(scopes.keys().next().value!)
  }
  if (Number(identity.sequence) <= scope.sequence) return
  if (begin) {
    scope.activeAttempt = identity.attemptId
    scope.active = true
  }
  if (scope.activeAttempt !== identity.attemptId) return
  scope.sequence = Number(identity.sequence)
  if (reset) scope.previews = scope.previews.filter(item => item.attemptId !== identity.attemptId)
  if (terminal) scope.active = false
  if (preview && scope.active) {
    const input = object(event.preview)
    if (!isWidgetInputPreview(input)) return
    const sourceBytes =
      typeof input.source === 'string' ? new TextEncoder().encode(input.source).byteLength : -1
    if (
      sourceBytes < 0 ||
      sourceBytes > 16 * 1024 ||
      !Number.isSafeInteger(input.bytes) ||
      Number(input.bytes) < sourceBytes ||
      Number(input.bytes) > 1024 * 1024 ||
      !['html', 'svg'].includes(String(input.format)) ||
      typeof event.id !== 'string' ||
      !event.id ||
      event.id.length > 256 ||
      typeof input.truncated !== 'boolean' ||
      typeof input.complete !== 'boolean'
    )
      return
    const item: WidgetInputPreview = {
      toolCallId: event.id,
      threadId: identity.threadId,
      turnId: identity.turnId,
      attemptId: identity.attemptId,
      source: input.source as string,
      format: input.format as 'html' | 'svg',
      bytes: Number(input.bytes),
      truncated: input.truncated,
      complete: input.complete,
      ...(typeof input.title === 'string' ? { title: input.title.slice(0, 256) } : {}),
    }
    const previous = scope.previews.find(
      value => value.attemptId === item.attemptId && value.toolCallId === item.toolCallId
    )
    if (previous && (item.bytes < previous.bytes || !item.source.startsWith(previous.source)))
      return
    scope.previews = [
      ...scope.previews.filter(
        previous => previous.attemptId !== item.attemptId || previous.toolCallId !== item.toolCallId
      ),
      item,
    ].slice(-8)
  }
  for (const listener of listeners) listener(identity.deviceId, identity.taskId, scope.previews)
}

export function clearWidgetPreviews(deviceId: string, taskId?: string) {
  for (const scopeKey of scopes.keys())
    if (scopeKey.startsWith(`${deviceId}\0`) && (!taskId || scopeKey === key(deviceId, taskId)))
      scopes.delete(scopeKey)
  for (const listener of listeners) listener(deviceId, taskId ?? '', [])
}
