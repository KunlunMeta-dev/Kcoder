import { getRuntimeConfig, joinAppPath } from '@/config/runtime'
import { invalidateChannelBindings } from './channelBindingEvents'
import { navigateGatewayLogin } from './gatewayLoginNavigation'
import { channelPlatforms } from './channelPlatforms'

import type { ChannelPlatform } from './channelPlatforms'
export type { ChannelPlatform } from './channelPlatforms'
export interface ChannelTarget {
  serverId: string
  workspacePath?: string
  threadId: string
}
export interface ChannelConnection {
  id: string
  platform: ChannelPlatform
  label: string
  configuration: Record<string, unknown>
  revision: number
  enabled: boolean
  hasCredential: boolean
  createdAtMs?: number | null
  state: 'configured' | 'starting' | 'connected' | 'degraded' | 'authorization_required' | 'stopped' | 'failed'
}
export interface ChannelBinding { chatId: string; target: ChannelTarget; revision: number; boundAtMs?: number | null }
export interface ChannelMessagePreview {
  text: string; senderId: string; senderName: string; timestampMs: number | null
  attachments: { kind: string; filename: string }[]
}
export interface ChannelChatDetails {
  chatId: string
  bindingRevision: number
  messages: (ChannelMessagePreview & { id: string; state: string })[]
  bindingInfo: { revision: number; status: 'available' | 'unavailable'; title?: string | null; serverLabel?: string; code?: string } | null
}
export interface ChannelDelivery {
  deliveryId: string
  deliveryState: 'pending' | 'sending' | 'accepted' | 'failed' | 'unknown'
  phase: 'result' | 'mirrored_input' | 'mirrored_reply'
  createdAtMs?: number
  code?: string
}
export interface ChannelChat {
  id: string
  connectionId: string
  label: string
  alias?: string
  aliasRevision?: number
  lastMessage?: ChannelMessagePreview | null
  range: {
    platform: ChannelPlatform
    connectionId: string
    tenantId: string
    chatKind: string
    chatId: string
    topicId: string | null
  }
  bindingRevision: number
  binding: ChannelBinding | null
  deliveries: ChannelDelivery[]
}
export interface ChannelInventory {
  installationId: string
  settings: ChannelSettings
  connections: ChannelConnection[]
  chats: ChannelChat[]
}
export interface ChannelToolRestrictions { enabled: boolean; disabledTools: string[] }
export interface ChannelSettings { mirrorClientTurns: boolean; toolRestrictions?: ChannelToolRestrictions }
export type ChannelAction =
  | { action: 'settings'; settings: Partial<ChannelSettings> }
  | { action: 'rename_connection'; connectionId: string; label: string; expectedRevision: number }
  | { action: 'rename_chat'; chatId: string; alias: string; expectedAliasRevision: number }
  | { action: 'save'; connection: Pick<ChannelConnection, 'id' | 'platform' | 'label' | 'configuration'>; credentials?: Record<string, unknown>; expectedRevision?: number }
  | { action: 'connect' | 'disconnect'; connectionId: string }
  | { action: 'remove'; connectionId: string; expectedRevision: number }
  | { action: 'bind'; chatId: string; target: ChannelTarget; expectedBindingRevision: number }
  | { action: 'unbind'; chatId: string; expectedBindingRevision: number }
  | { action: 'send'; chatId: string; deliveryId: string; text: string }
  | { action: 'authorization_begin'; flowId: string; platform: ChannelPlatform; connectionId: string; expectedRevision: number }
  | { action: 'authorization_poll'; flowId: string; verifyCode?: string }
  | { action: 'authorization_read' | 'authorization_cancel'; flowId: string }
  | { action: 'authorization_commit'; flowId: string; label: string; features?: Record<string, unknown> }

export interface ChannelAuthorization {
  flowId: string
  state: string
  verificationKind?: 'image'
  verificationUrl?: string
  intervalMs?: number
  expiresAtMs?: number
  appId?: string
  connection?: { id: string; revision: number }
}

export class ChannelRequestError extends Error {
  readonly code: string
  readonly uncertain: boolean
  constructor(code: string, uncertain = false) { super(code); this.code = code; this.uncertain = uncertain }
}

const record = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === 'object' && !Array.isArray(value)
const string = (value: unknown): value is string => typeof value === 'string' && value.length > 0
const revision = (value: unknown): value is number => Number.isSafeInteger(value) && Number(value) >= 0
const timestamp = (value: unknown) => value === null || revision(value)
const preview = (value: unknown) => record(value) && typeof value.text === 'string' && value.text.length <= 1000
  && typeof value.senderId === 'string' && typeof value.senderName === 'string' && timestamp(value.timestampMs)
  && Array.isArray(value.attachments) && value.attachments.length <= 8
  && value.attachments.every(item => record(item) && typeof item.kind === 'string' && typeof item.filename === 'string')
const platforms = new Set(Object.keys(channelPlatforms))

/** The Gateway owns connections; target/workspace identity is only used to route an original task. */
export function readChannelInventory(value: unknown): ChannelInventory {
  if (!record(value) || !string(value.installationId) || !record(value.settings)
    || typeof value.settings.mirrorClientTurns !== 'boolean'
    || (value.settings.toolRestrictions !== undefined && (!record(value.settings.toolRestrictions)
      || typeof value.settings.toolRestrictions.enabled !== 'boolean' || !Array.isArray(value.settings.toolRestrictions.disabledTools)
      || !value.settings.toolRestrictions.disabledTools.every(name => typeof name === 'string')))
    || !Array.isArray(value.connections) || !Array.isArray(value.chats)) {
    throw new ChannelRequestError('CHANNEL_INVENTORY_INVALID')
  }
  const connections = new Map<string, Record<string, unknown>>()
  for (const connection of value.connections) {
    if (!record(connection) || !string(connection.id) || connections.has(connection.id)
      || !platforms.has(String(connection.platform)) || typeof connection.label !== 'string'
      || !record(connection.configuration) || !revision(connection.revision)
      || typeof connection.enabled !== 'boolean' || typeof connection.hasCredential !== 'boolean'
      || !(connection.createdAtMs === undefined || timestamp(connection.createdAtMs))
      || !['configured', 'starting', 'connected', 'degraded', 'authorization_required', 'stopped', 'failed'].includes(String(connection.state))) {
      throw new ChannelRequestError('CHANNEL_INVENTORY_INVALID')
    }
    connections.set(connection.id, connection)
  }
  const seen = new Set<string>()
  for (const chat of value.chats) {
    if (!record(chat) || !string(chat.id) || seen.has(chat.id) || !string(chat.connectionId)
      || !connections.has(chat.connectionId) || !record(chat.range)
      || chat.range.connectionId !== chat.connectionId || chat.range.platform !== connections.get(chat.connectionId)?.platform
      || !string(chat.range.tenantId) || !string(chat.range.chatId) || !string(chat.range.chatKind)
      || !(chat.range.topicId === null || typeof chat.range.topicId === 'string')
      || typeof chat.label !== 'string' || !revision(chat.bindingRevision)
      || !(chat.alias === undefined || typeof chat.alias === 'string' && chat.alias.length <= 256)
      || !(chat.aliasRevision === undefined || revision(chat.aliasRevision))
      || !(chat.lastMessage == null || preview(chat.lastMessage))
      || !Array.isArray(chat.deliveries) || chat.deliveries.length > 20
      || !chat.deliveries.every(delivery => record(delivery) && string(delivery.deliveryId)
        && ['pending', 'sending', 'accepted', 'failed', 'unknown'].includes(String(delivery.deliveryState))
        && ['result', 'mirrored_input', 'mirrored_reply'].includes(String(delivery.phase))
        && (delivery.createdAtMs === undefined || revision(delivery.createdAtMs))
        && (delivery.code === undefined || typeof delivery.code === 'string' && /^[A-Z][A-Z0-9_]{1,100}$/.test(delivery.code)))) {
      throw new ChannelRequestError('CHANNEL_INVENTORY_INVALID')
    }
    if (chat.binding !== null && (!record(chat.binding) || chat.binding.chatId !== chat.id
      || chat.binding.revision !== chat.bindingRevision || !record(chat.binding.target)
      || !string(chat.binding.target.serverId) || !string(chat.binding.target.threadId)
      || !(chat.binding.target.workspacePath === undefined || string(chat.binding.target.workspacePath)))) {
      throw new ChannelRequestError('CHANNEL_INVENTORY_INVALID')
    }
    seen.add(chat.id)
  }
  return value as unknown as ChannelInventory
}

async function request(body?: ChannelAction, signal?: AbortSignal, chatId?: string): Promise<unknown> {
  let response: Response
  try {
    response = await fetch(joinAppPath(getRuntimeConfig().appBasePath, '/api/channels') + (chatId ? `?${new URLSearchParams({ chatId })}` : ''), {
      method: body ? 'POST' : 'GET', credentials: 'same-origin',
      headers: { Accept: 'application/json', ...(body ? { 'Content-Type': 'application/json' } : {}) },
      ...(body ? { body: JSON.stringify(body) } : {}),
      signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(65000)]) : AbortSignal.timeout(65000),
    })
  } catch { throw new ChannelRequestError('CHANNEL_REQUEST_UNKNOWN', !!body) }
  if (response.status === 401) { navigateGatewayLogin(); throw new ChannelRequestError('GATEWAY_LOGIN_REQUIRED') }
  let value: unknown
  try { value = await response.json() }
  catch { throw new ChannelRequestError('CHANNEL_RESPONSE_UNKNOWN', !!body) }
  if (!response.ok) throw new ChannelRequestError(record(value) && typeof value.code === 'string'
    && /^[A-Z][A-Z0-9_]{1,100}$/.test(value.code) ? value.code : 'CHANNEL_OPERATION_FAILED')
  return value
}

export async function channelInventory(signal?: AbortSignal): Promise<ChannelInventory> {
  return readChannelInventory(await request(undefined, signal))
}

/** Load a bounded Inbox view and the current binding title only when a chat is opened. */
export async function channelChatDetails(chatId: string, signal?: AbortSignal): Promise<ChannelChatDetails> {
  const value = await request(undefined, signal, chatId)
  if (!record(value) || value.chatId !== chatId || !revision(value.bindingRevision)
    || !Array.isArray(value.messages) || value.messages.length > 3
    || !value.messages.every(message => preview(message) && record(message) && string(message.id) && typeof message.state === 'string')
    || (value.bindingInfo !== null && (!record(value.bindingInfo) || !['available', 'unavailable'].includes(String(value.bindingInfo.status))
      || value.bindingInfo.revision !== value.bindingRevision
      || !(value.bindingInfo.title == null || typeof value.bindingInfo.title === 'string')
      || !(value.bindingInfo.serverLabel === undefined || typeof value.bindingInfo.serverLabel === 'string')))) {
    throw new ChannelRequestError('CHANNEL_RESPONSE_UNKNOWN')
  }
  return value as unknown as ChannelChatDetails
}

/** Mutations have no automatic retry. A lost reply is reconciled with a fresh inventory. */
export async function channelAction<T = unknown>(body: ChannelAction, signal?: AbortSignal): Promise<T> {
  const result = await request(body, signal)
  invalidateChannelBindings('gateway-channels')
  return result as T
}

export function sameChannelTask(left: ChannelTarget | null | undefined, right: ChannelTarget) {
  return left?.serverId === right.serverId && left.workspacePath === right.workspacePath && left.threadId === right.threadId
}
