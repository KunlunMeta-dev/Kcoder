import { reduceWorkbenchMessages, isActiveToolCallStatus } from '@wegent/chat-core'
import type { WorkbenchMessage } from '@/types/workbench'
import type { NormalizedRuntimeMessage, RuntimeTaskAddress, ChatBlock } from '@/types/api'
import type {
  RuntimeSubagentConversationSnapshot,
  RuntimeSubagentConversationEvent,
} from '@/types/subagents'
import {
  createRuntimeTaskStreamHandlers,
  runtimeMessagesToWorkbenchMessages,
  type RuntimePaneMessageAction,
} from '@/features/workbench/runtimePaneMessages'
import { toolObservationOutput } from './toolObservationOutput'
import { record, text } from './gateway/runtime/contracts'

/** Public wire frames use the ordinary conversation normalizer and action reducer. */
export class SubagentConversationProjection {
  private assistantId = ''
  private lastError = ''
  private messages: WorkbenchMessage[] = []
  private toolOwners = new Map<string, string>()
  private actions: RuntimePaneMessageAction[] = []
  private readonly handlers
  private readonly address: RuntimeTaskAddress
  constructor(address: RuntimeTaskAddress) {
    this.address = address
    this.handlers = createRuntimeTaskStreamHandlers(address, {
      onMessageAction: action => this.actions.push(action),
    })
  }
  snapshot(raw: Record<string, unknown>): RuntimeSubagentConversationSnapshot {
    this.toolOwners.clear()
    const input = Array.isArray(raw.messages) ? raw.messages : []
    const messages: NormalizedRuntimeMessage[] = input.map(value => {
      const message = record(value)
      const clientMessageId = message.role === 'user' ? text(message.clientMessageId) : null
      const id = clientMessageId ?? text(message.id) ?? ''
      if (!id || !['user', 'assistant'].includes(String(message.role)))
        throw new Error('invalid public subagent message')
      const blocks = Array.isArray(message.blocks) ? message.blocks : []
      for (const block of blocks) {
        const value = record(block)
        if (value.type === 'tool' && typeof value.id === 'string') this.toolOwners.set(value.id, id)
      }
      const stamp =
        typeof message.timestampMs === 'number' && message.timestampMs > 0
          ? new Date(message.timestampMs).toISOString()
          : ''
      return {
        ...message,
        id,
        role: String(message.role),
        content: typeof message.content === 'string' ? message.content : '',
        status: text(message.status) ?? 'done',
        subtaskId: id,
        // This view renders each assistant item as an independent stream row.
        // The ordinary reducer compares block updates against that row's turn
        // identity; the enclosing Agent run remains on the snapshot envelope.
        turnId: id,
        ...(clientMessageId ? { source: { source: 'subagent-command', clientMessageId } } : {}),
        createdAt: stamp,
        blocks,
      } as NormalizedRuntimeMessage
    })
    this.assistantId =
      text(raw.activeAssistantItemId) ??
      messages.filter(message => message.role === 'assistant').at(-1)?.id ??
      ''
    const commandSources = new Map(
      messages.flatMap(message =>
        message.role === 'user' && typeof message.clientMessageId === 'string'
          ? [
              [
                message.clientMessageId,
                { source: 'subagent-command', clientMessageId: message.clientMessageId },
              ] as const,
            ]
          : []
      )
    )
    this.messages = runtimeMessagesToWorkbenchMessages(messages).map(message =>
      commandSources.has(message.id)
        ? { ...message, source: commandSources.get(message.id) }
        : message
    )
    this.lastError = this.messages.at(-1)?.error ?? ''
    return {
      ...raw,
      messages: this.messages,
    } as unknown as RuntimeSubagentConversationSnapshot
  }
  event(raw: Record<string, unknown>): RuntimeSubagentConversationEvent {
    const method = String(raw.method ?? '')
    const params = record(raw.params),
      item = record(params.item),
      event = record(params.event)
    const occurred =
      typeof raw.occurredAtMs === 'number' && raw.occurredAtMs > 0 ? raw.occurredAtMs : 0
    this.actions = []
    const base = (subtaskId = this.assistantId) => ({
      deviceId: this.address.deviceId,
      taskId: this.address.taskId,
      subtaskId,
    })
    const ensureAssistant = () => {
      if (!this.assistantId) {
        this.assistantId = `${raw.runId}:assistant`
        this.handlers.onChatStart?.(base())
      }
    }
    let terminalStatus: 'completed' | 'interrupted' | 'failed' | undefined
    const terminalUnresolved = new Set(
      this.messages.flatMap(message =>
        (message.blocks ?? [])
          .filter(block => isActiveToolCallStatus(block.status))
          .map(block => block.id)
      )
    )
    const currentContent = (id: string) =>
      this.messages.find(message => message.subtaskId === id || message.id === id)?.content ?? ''
    if (method === 'item/started' && item.type === 'agentMessage') {
      this.assistantId = String(item.id)
      this.handlers.onChatStart?.(base())
    } else if (method === 'item/started' && item.type === 'userMessage') {
      const clientMessageId =
        text(item.clientMessageId) ?? text(record(item.message).clientMessageId)
      const id = clientMessageId ?? text(item.id)
      if (!id) throw new Error('subagent user message identity missing')
      this.actions.push({
        type: 'user_added',
        message: {
          id,
          role: 'user',
          source: clientMessageId ? { source: 'subagent-command', clientMessageId } : undefined,
          content: String(item.text ?? item.content ?? ''),
          status: 'done',
          createdAt: occurred > 0 ? new Date(occurred).toISOString() : '',
        },
      })
    } else if (method === 'item/delta') {
      const id = text(params.itemId)
      if (id) this.assistantId = id
      ensureAssistant()
      const delta = record(params.delta)
      if (typeof delta.text === 'string')
        this.handlers.onChatChunk?.({ ...base(), content: delta.text })
    } else if (method === 'item/started' && item.type === 'toolCall') {
      ensureAssistant()
      const id = String(item.id),
        name = String(item.name ?? 'tool')
      this.toolOwners.set(id, this.assistantId)
      const block = {
        id,
        type: 'tool',
        tool_name: name,
        toolName: name,
        tool_input: record(item.input),
        status: 'pending',
        timestamp: occurred,
      } as ChatBlock
      this.handlers.onBlockCreated?.({ ...base(), block })
    } else if (method === 'item/completed' && item.type === 'toolCall') {
      const id = String(item.id),
        owner = this.toolOwners.get(id) ?? this.assistantId
      ensureAssistant()
      this.handlers.onBlockUpdated?.({
        ...base(owner),
        blockId: id,
        status:
          item.status === 'failed' ? 'error' : item.status === 'completed' ? 'done' : 'unknown',
        toolOutput: toolObservationOutput(item),
      })
    } else if (method === 'item/completed' && item.type === 'agentMessage') {
      // A model message ends before its requested tools execute. Only the run
      // terminal event may settle tools; completing text must retain argument
      // progress and tool lifecycle states exactly as ordinary chat does.
      this.actions.push({
        type: 'reset',
        messages: this.messages.map(message =>
          message.id === item.id || message.subtaskId === item.id
            ? { ...message, status: 'done' }
            : message
        ),
      })
    } else if (method === 'item/event') {
      const type = text(event.type)
      if (type === 'error' && typeof event.error === 'string') {
        ensureAssistant()
        this.lastError = event.error
        this.handlers.onChatError?.({ ...base(), error: this.lastError })
      } else if (type === 'tool_input_reset') {
        this.actions.push({
          type: 'reset',
          messages: this.messages.map(message => ({
            ...message,
            blocks: message.blocks?.filter(block => block.status !== 'generating_arguments'),
          })),
        })
      } else if (type === 'tool_denied' && text(event.id)) {
        this.handlers.onBlockUpdated?.({
          ...base(this.toolOwners.get(String(event.id)) ?? this.assistantId),
          blockId: String(event.id),
          status: 'error',
          toolOutput: String(event.reason ?? 'Tool denied'),
        })
      } else if (type === 'tool_input_progress' && text(event.id)) {
        ensureAssistant()
        this.handlers.onBlockCreated?.({
          ...base(),
          block: {
            id: String(event.id),
            type: 'tool',
            tool_name: String(event.name ?? 'tool'),
            status: 'generating_arguments',
            timestamp: occurred,
          } as ChatBlock,
        })
      } else if (type === 'tool_output_delta' && text(event.id)) {
        const id = String(event.id)
        this.handlers.onBlockUpdated?.({
          ...base(this.toolOwners.get(id) ?? this.assistantId),
          blockId: id,
          toolOutputDelta: String(event.delta ?? event.text ?? ''),
          status: 'streaming',
        })
      }
    } else if (method === 'turn/completed') {
      const status = text(record(params.turn).status)
      terminalStatus =
        status === 'failed' ? 'failed' : status === 'completed' ? 'completed' : 'interrupted'
      if (this.assistantId) {
        if (terminalStatus === 'completed')
          this.handlers.onChatDone?.({
            ...base(),
            result: { turnId: String(raw.runId), value: currentContent(this.assistantId) },
          })
        else
          this.actions.push({
            type: terminalStatus === 'failed' ? 'assistant_error' : 'assistant_cancelled',
            subtaskId: this.assistantId,
            ...(terminalStatus === 'failed'
              ? {
                  error:
                    this.lastError || String(record(params.error).message ?? 'Subagent failed'),
                }
              : {}),
          } as RuntimePaneMessageAction)
      }
    }
    this.messages = this.actions.reduce(
      (state, action) => reduceWorkbenchMessages(state, action),
      this.messages
    )
    if (terminalStatus) {
      this.messages = this.messages.map(message => ({
        ...message,
        blocks: message.blocks?.map(block =>
          terminalUnresolved.has(block.id)
            ? { ...block, status: 'unknown' as const, rawStatus: 'result_unrecorded' }
            : block
        ),
      }))
      this.actions.push({ type: 'reset', messages: this.messages })
    }
    return {
      ...raw,
      type: 'event',
      method,
      params,
      actions: this.actions,
      ...(terminalStatus ? { terminalStatus } : {}),
    } as RuntimeSubagentConversationEvent
  }
}
