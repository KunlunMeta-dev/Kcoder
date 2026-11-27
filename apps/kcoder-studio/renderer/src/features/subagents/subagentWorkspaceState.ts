import type { RuntimeSubagentSteerResponse } from '@/types/api'

export interface SubagentArtifactPage {
  content: string
  offset: number
  nextOffset?: number
  revision: string
  size: number
  truncated: boolean
}

export interface SubagentCommand {
  clientMessageId: string
  message: string
  status: 'sending' | 'unknown' | 'applied' | string
  messageId?: string
  reasonCode?: string
  bodyDigest?: string
  createdAtMs?: number
}

/** Application wins over a delayed queued acknowledgement for the same identity. */
export function mergeCommandReceipt(
  command: SubagentCommand,
  receipt: RuntimeSubagentSteerResponse
): SubagentCommand {
  if (receipt.clientMessageId !== command.clientMessageId) return command
  if (command.messageId && receipt.messageId && command.messageId !== receipt.messageId) {
    return command
  }
  return {
    ...command,
    messageId: receipt.messageId ?? command.messageId,
    status: command.status === 'applied' ? 'applied' : receipt.status,
    reasonCode: receipt.reasonCode,
  }
}

export function markCommandApplied(
  command: SubagentCommand,
  messageIds: readonly string[],
  clientMessageId?: string
): SubagentCommand {
  return (
    command.messageId
      ? messageIds.includes(command.messageId)
      : clientMessageId === command.clientMessageId && messageIds.length > 0
  )
    ? { ...command, status: 'applied' }
    : command
}

/** Pages from different file snapshots must never be concatenated. */
export function appendArtifactPage(
  current: SubagentArtifactPage | null,
  incoming: SubagentArtifactPage
): SubagentArtifactPage | null {
  if (incoming.offset === 0) return incoming
  if (
    !current ||
    current.revision !== incoming.revision ||
    current.nextOffset !== incoming.offset
  ) {
    return null
  }
  return { ...incoming, offset: current.offset, content: current.content + incoming.content }
}
