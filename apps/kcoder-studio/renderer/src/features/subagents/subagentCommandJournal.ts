import type { SubagentCommand } from './subagentWorkspaceState'

const MAX_PENDING_COMMANDS = 256
const MAX_JOURNAL_BYTES = 128 * 1024
const terminalStatuses = new Set(['applied', 'rejected', 'dead_letter', 'cancelled', 'closed'])
type JournalStorage = Pick<Storage, 'getItem' | 'setItem'>

export interface SubagentPendingCommandIntent {
  clientMessageId: string
  bodyDigest: string
  createdAtMs: number
  messageId?: string
  status: 'unknown'
}

/** Non-authoritative UI fingerprint. Server SHA-256 remains the payload authority. */
export function subagentCommandDigest(message: string): string {
  const bytes = new TextEncoder().encode(message)
  let first = 2166136261
  let second = 3339675911
  for (const byte of bytes) {
    first = Math.imul(first ^ byte, 16777619)
    second = Math.imul(second ^ byte, 16777619)
  }
  const hex = (value: number) => (value >>> 0).toString(16).padStart(8, '0')
  return `ui-fnv64-v1:${hex(first)}${hex(second)}:${bytes.byteLength}`
}

/** Recovery handles for lookup only. No command body, credentials, send, or automatic retry. */
export class SubagentCommandJournal {
  private readonly key: string
  private readonly storage: JournalStorage

  /** The safe host scope must include account, target, parent thread and actual agent identity. */
  constructor(
    storage: JournalStorage,
    scope: string
  ) {
    if (!scope.trim()) throw new Error('subagent command journal scope is required')
    this.storage = storage
    this.key = `kcoder.subagent.pendingCommands.v1:${scope}`
  }

  load(): SubagentPendingCommandIntent[] {
    return this.read()
  }

  /** Persist a recovery handle before invoking the host steer callback. */
  remember(command: SubagentCommand): void {
    if (new TextEncoder().encode(command.message).byteLength > 64 * 1024)
      throw new Error('subagent command exceeds its byte budget')
    const current = this.read()
    const bodyDigest = subagentCommandDigest(command.message)
    const existing = current.find(item => item.clientMessageId === command.clientMessageId)
    if (existing && existing.bodyDigest !== bodyDigest)
      throw new Error('client command identity conflict')
    const intent: SubagentPendingCommandIntent = {
      clientMessageId: command.clientMessageId,
      bodyDigest,
      createdAtMs: existing?.createdAtMs ?? Date.now(),
      messageId: command.messageId ?? existing?.messageId,
      status: 'unknown',
    }
    this.save(
      existing
        ? current.map(item => (item.clientMessageId === command.clientMessageId ? intent : item))
        : [...current, intent]
    )
  }

  /** Only an authoritative receipt may release its UI observation handle. */
  update(command: SubagentCommand): void {
    const current = this.read()
    if (terminalStatuses.has(command.status)) {
      this.save(current.filter(item => item.clientMessageId !== command.clientMessageId))
    } else {
      this.save(
        current.map(item =>
          item.clientMessageId === command.clientMessageId
            ? { ...item, messageId: command.messageId ?? item.messageId }
            : item
        )
      )
    }
  }

  /** Invoke only after observing the target's confirmed archive epoch. */
  retireBeforeEpoch(epoch: number): void {
    if (!Number.isSafeInteger(epoch) || epoch < 0) throw new Error('invalid command journal epoch')
    this.save(
      this.read().filter(intent => {
        const match = /^cmd:([0-9]+):/.exec(intent.clientMessageId)
        return match ? Number(match[1]) >= epoch : epoch === 0
      })
    )
  }

  private read(): SubagentPendingCommandIntent[] {
    const raw = this.storage.getItem(this.key)
    if (!raw) return []
    if (
      raw.length > MAX_JOURNAL_BYTES ||
      new TextEncoder().encode(raw).byteLength > MAX_JOURNAL_BYTES
    )
      throw new Error('subagent command journal exceeds its byte budget')
    const data: unknown = JSON.parse(raw)
    if (
      !data ||
      typeof data !== 'object' ||
      !('version' in data) ||
      data.version !== 1 ||
      !('commands' in data) ||
      !Array.isArray(data.commands) ||
      data.commands.length > MAX_PENDING_COMMANDS
    )
      throw new Error('subagent command journal format is unavailable')
    const commands = data.commands.map((item: unknown): SubagentPendingCommandIntent => {
      if (
        !item ||
        typeof item !== 'object' ||
        !('clientMessageId' in item) ||
        typeof item.clientMessageId !== 'string' ||
        !item.clientMessageId ||
        item.clientMessageId.length > 128 ||
        !('bodyDigest' in item) ||
        typeof item.bodyDigest !== 'string' ||
        !/^ui-fnv64-v1:[0-9a-f]{16}:[0-9]{1,6}$/.test(item.bodyDigest) ||
        !('createdAtMs' in item) ||
        typeof item.createdAtMs !== 'number' ||
        !Number.isSafeInteger(item.createdAtMs) ||
        item.createdAtMs < 0
      )
        throw new Error('subagent command journal entry is invalid')
      return {
        clientMessageId: item.clientMessageId,
        bodyDigest: item.bodyDigest,
        createdAtMs: item.createdAtMs,
        messageId:
          'messageId' in item && typeof item.messageId === 'string' ? item.messageId : undefined,
        status: 'unknown',
      }
    })
    if (new Set(commands.map(command => command.clientMessageId)).size !== commands.length)
      throw new Error('subagent command journal contains duplicate identities')
    return commands
  }

  private save(commands: SubagentPendingCommandIntent[]): void {
    if (commands.length > MAX_PENDING_COMMANDS)
      throw new Error('subagent pending command journal is full')
    const value = JSON.stringify({ version: 1, commands })
    if (new TextEncoder().encode(value).byteLength > MAX_JOURNAL_BYTES)
      throw new Error('subagent pending command journal is full')
    this.storage.setItem(this.key, value)
  }
}
