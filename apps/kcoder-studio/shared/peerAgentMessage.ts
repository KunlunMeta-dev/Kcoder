import { validAgentMessageAddress } from './agentMessageMethods.mjs'
import type { PeerAgentMessageV1, SessionAddressV1 } from './generated/contracts'
/** Provenance is read only from the host's structured envelope, never message text. */
export type PeerAgentMessageMetadata = Omit<PeerAgentMessageV1, 'version' | 'sourceAddress' | 'targetAddress'> & {
  version: 1
  replyToMessageId?: string
  sourceAddress?: SessionAddress
  targetAddress?: SessionAddress
}
/** A selector, never an authorization grant or a URL to open. */
export type SessionAddress = SessionAddressV1
const object = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value)
const id = (value: unknown): value is string => typeof value === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(value)
export function sessionAddress(value: unknown): SessionAddress | null {
  if (!validAgentMessageAddress(value)) return null
  return { targetId: value.targetId, workspaceId: value.workspaceId, threadId: value.threadId }
}
export function sessionAddressKey(value: SessionAddress): string {
  return JSON.stringify([value.targetId, value.workspaceId, value.threadId])
}
export function isPeerAgentMessage(value: unknown): boolean {
  return object(value) && (value.origin === 'peer_agent' || value.role === 'peer_agent' || value.type === 'peerAgentMessage')
}
export function peerAgentMetadata(value: unknown, targetThreadId?: string): PeerAgentMessageMetadata | null {
  if (!object(value) || !isPeerAgentMessage(value)) return null
  const metadata = value.agentMessage ?? value.agent_message
  if (!object(metadata) || metadata.version !== 1 || metadata.replyToMessageId != null && !id(metadata.replyToMessageId) || !id(metadata.messageId) || !id(metadata.sourceThreadId) ||
      !id(metadata.targetThreadId) || targetThreadId !== undefined && metadata.targetThreadId !== targetThreadId ||
      typeof metadata.createdAtMs !== 'number' || !Number.isSafeInteger(metadata.createdAtMs) || metadata.createdAtMs <= 0 ||
      typeof metadata.bodySha256 !== 'string' || !/^[a-fA-F0-9]{64}$/.test(metadata.bodySha256)) return null
  const source = sessionAddress(metadata.sourceAddress), target = sessionAddress(metadata.targetAddress)
  const addressed = metadata.sourceAddress != null || metadata.targetAddress != null
  if (addressed && (!source || !target || source.threadId !== metadata.sourceThreadId ||
      target.threadId !== metadata.targetThreadId || sessionAddressKey(source) === sessionAddressKey(target)) ||
      !addressed && metadata.sourceThreadId === metadata.targetThreadId) return null
  return { version: 1, ...(metadata.replyToMessageId == null ? {} : { replyToMessageId: metadata.replyToMessageId as string }), messageId: metadata.messageId, sourceThreadId: metadata.sourceThreadId,
    targetThreadId: metadata.targetThreadId, createdAtMs: metadata.createdAtMs, bodySha256: metadata.bodySha256,
    ...(source && target ? { sourceAddress: source, targetAddress: target } : {}) }
}

/** A peer row cannot mount tool, attachment, widget or user-input payloads. */
export function peerAgentItem(value: unknown, targetThreadId?: string) {
  if (!object(value)) return null
  const nested = object(value.content) ? value.content : object(value.message) ? value.message : undefined
  const envelope = nested && isPeerAgentMessage(nested) ? nested : value
  if (!isPeerAgentMessage(value) && !isPeerAgentMessage(nested)) return null
  const itemId = nested?.id ?? value.id
  const content = typeof nested?.content === 'string' ? nested.content : typeof value.text === 'string' ? value.text : undefined
  if (typeof itemId !== 'string' || !itemId || !content) return null
  const timestamp = nested?.timestampMs ?? value.timestampMs ?? value.timestamp
  const metadata = peerAgentMetadata(envelope, targetThreadId)
  return { id: itemId, role: 'peer_agent' as const, origin: 'peer_agent' as const, content,
    agentMessage: metadata, status: 'completed' as const,
    timestampMs: typeof timestamp === 'number' && Number.isSafeInteger(timestamp) && timestamp >= 0 &&
      timestamp <= 8_640_000_000_000_000 ? timestamp : metadata?.createdAtMs ?? 0 }
}
