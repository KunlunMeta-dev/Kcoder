import type { RuntimePaneMessageAction } from '@/features/workbench/runtimePaneMessages'
import type { RuntimeTaskAddress } from '@/types/api'
import type { WorkbenchMessage } from '@/types/workbench'

export function runtimeAddressDebug(address: RuntimeTaskAddress): Record<string, unknown> {
  return {
    deviceId: address.deviceId,
    taskId: address.taskId,
    workspacePath: address.workspacePath ?? null,
    hasRuntimeHandle: Boolean(address.runtimeHandle),
    runtimeHandleKeys: address.runtimeHandle ? Object.keys(address.runtimeHandle).sort() : [],
  }
}

export function summarizeWorkbenchMessages(
  messages: WorkbenchMessage[]
): Record<string, unknown>[] {
  return messages.map(message => ({
    id: message.id,
    role: message.role,
    status: message.status,
    contentLength: message.content.length,
    subtaskId: message.subtaskId ?? null,
  }))
}

export function debugRuntimePaneMessageFlow(event: string, details: Record<string, unknown>) {
  if (!isRuntimeDebugEnabled()) return
  console.debug('[KCoder Studio] Runtime pane message flow', {
    event,
    ...details,
  })
}

export function isBatchableRuntimePaneMessageAction(action: RuntimePaneMessageAction): boolean {
  return action.type === 'assistant_chunk' || action.type === 'block_updated'
}

export function isRuntimeDebugEnabled(): boolean {
  return globalThis.localStorage?.getItem('wework:debug-runtime') === '1'
}
