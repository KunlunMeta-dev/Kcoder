import type { CrossSessionMessageReceipt, CrossSessionMessageSendParams } from './generated/contracts'
import { agentMessageId, agentMessageUtf8Bytes, validAgentMessageReceipt } from './agentMessageMethods.mjs'
import { sessionAddress, sessionAddressKey, type SessionAddress } from './peerAgentMessage'
export type AddressedMessageIntent = CrossSessionMessageSendParams & { targetAddress?: SessionAddress | null }
export interface AgentMessageObservation {
  clientMessageId: string
  targetThreadId: string
  targetAddress?: SessionAddress
  createdAtMs: number
  bodyDigest: string
  receipt?: CrossSessionMessageReceipt
}
export type AgentMessageJournalLock = <T>(work: () => Promise<T>) => Promise<T>
export interface AgentMessageJournalStorage {
  getItem(key: string): string | null | Promise<string | null>
  setItem(key: string, value: string): void | Promise<void>
}
/** A UI comparison only. A collision can cause a server conflict, never authorize a changed request. */
export function agentMessageIntentDigest(intent: Pick<AddressedMessageIntent, 'targetThreadId' | 'targetAddress' | 'mode' | 'text' | 'expectedTurnId'>): string {
  const value = JSON.stringify([intent.targetAddress ? sessionAddressKey(intent.targetAddress) : intent.targetThreadId, intent.mode, intent.expectedTurnId ?? null, intent.text])
  let first = 2166136261; let second = 3339675911
  for (let index = 0; index < value.length; index += 1) { first = Math.imul(first ^ value.charCodeAt(index), 16777619); second = Math.imul(second ^ value.charCodeAt(index), 16777619) }
  return `ui-fnv64-v1:${(first >>> 0).toString(16).padStart(8, '0')}${(second >>> 0).toString(16).padStart(8, '0')}:${value.length}`
}
export function receiptMatchesObservation(receipt: CrossSessionMessageReceipt, row: AgentMessageObservation): boolean {
  if (!validAgentMessageReceipt(receipt) || receipt.clientMessageId !== row.clientMessageId || receipt.targetThreadId !== row.targetThreadId) return false
  const incoming = receipt as CrossSessionMessageReceipt & { targetAddress?: SessionAddress; sourceAddress?: SessionAddress }
  if (row.targetAddress && (!incoming.targetAddress || sessionAddressKey(incoming.targetAddress) !== sessionAddressKey(row.targetAddress))) return false
  if (!row.receipt) return true
  const previous = row.receipt as typeof incoming
  if (receipt.messageId !== previous.messageId || receipt.revision < previous.revision ||
      receipt.revision === previous.revision && receipt.status !== previous.status ||
      ['applied', 'rejected', 'expired'].includes(previous.status) && receipt.status !== previous.status) return false
  return JSON.stringify([incoming.sourceAddress && sessionAddressKey(incoming.sourceAddress), incoming.targetAddress && sessionAddressKey(incoming.targetAddress)]) ===
    JSON.stringify([previous.sourceAddress && sessionAddressKey(previous.sourceAddress), previous.targetAddress && sessionAddressKey(previous.targetAddress)])
}
const MAX_RECORDS = 64
const MAX_BYTES = 64 * 1024
/** Lookup handles only: no body, credentials, permission verdict or automatic resend. */
export class AgentMessageJournal {
  private readonly key: string
  private readonly storage: AgentMessageJournalStorage
  private readonly lock: AgentMessageJournalLock
  constructor(storage: AgentMessageJournalStorage, scope: string, lock: AgentMessageJournalLock) {
    this.storage = storage
    this.lock = lock
    if (!scope || scope.length > 8192) throw new Error('agent_message_scope_unavailable')
    this.key = `kcoder.agent-messages.v1:${encodeURIComponent(scope)}`
  }
  async load(): Promise<AgentMessageObservation[]> {
    const raw = await this.storage.getItem(this.key)
    if (!raw) return []
    if (agentMessageUtf8Bytes(raw) > MAX_BYTES) throw new Error('agent_message_recovery_record_invalid')
    const values: unknown = JSON.parse(raw)
    if (!Array.isArray(values) || values.length > MAX_RECORDS) throw new Error('agent_message_recovery_record_invalid')
    const ids = new Set<string>()
    for (const row of values) {
      if (!row || Object.keys(row).some(key => !['clientMessageId', 'targetThreadId', 'targetAddress', 'createdAtMs', 'bodyDigest', 'receipt'].includes(key)) || !agentMessageId(row.clientMessageId) || !agentMessageId(row.targetThreadId) ||
          row.targetAddress !== undefined && (!sessionAddress(row.targetAddress) || row.targetAddress.threadId !== row.targetThreadId) ||
          typeof row.bodyDigest !== 'string' || !/^ui-fnv64-v1:[a-f0-9]{16}:[0-9]+$/.test(row.bodyDigest) || !Number.isSafeInteger(row.createdAtMs) || row.createdAtMs < 0 || ids.has(row.clientMessageId) ||
          row.receipt !== undefined && !receiptMatchesObservation(row.receipt, { ...row, receipt: undefined }))
        throw new Error('agent_message_recovery_record_invalid')
      ids.add(row.clientMessageId)
    }
    return values as AgentMessageObservation[]
  }
  private async save(rows: AgentMessageObservation[]) {
    const raw = JSON.stringify(rows)
    if (agentMessageUtf8Bytes(raw) > MAX_BYTES) throw new Error('agent_message_recovery_capacity')
    await this.storage.setItem(this.key, raw)
  }
  async remember(intent: AddressedMessageIntent): Promise<void> {
    await this.lock(async () => {
    const rows = await this.load()
    const original = rows.find(row => row.clientMessageId === intent.clientMessageId)
    if (original) throw new Error('agent_message_request_already_recorded')
    if (rows.length >= MAX_RECORDS) {
      const terminal = rows.findIndex(row => row.receipt && ['applied', 'rejected', 'expired'].includes(row.receipt.status))
      if (terminal < 0) throw new Error('agent_message_recovery_capacity')
      rows.splice(terminal, 1)
    }
    rows.push({ clientMessageId: intent.clientMessageId, targetThreadId: intent.targetThreadId,
      ...(intent.targetAddress ? { targetAddress: { ...intent.targetAddress } } : {}), createdAtMs: Date.now(), bodyDigest: agentMessageIntentDigest(intent) })
    await this.save(rows)
    })
  }
  async observe(receipt: CrossSessionMessageReceipt): Promise<void> {
    await this.lock(async () => {
    if (!validAgentMessageReceipt(receipt)) throw new Error('agent_message_invalid_receipt')
    const rows = await this.load()
    const row = rows.find(row => row.clientMessageId === receipt.clientMessageId)
    if (!row || !receiptMatchesObservation(receipt, row)) throw new Error('agent_message_receipt_owner_changed')
    row.receipt = receipt
    await this.save(rows)
    })
  }
}
