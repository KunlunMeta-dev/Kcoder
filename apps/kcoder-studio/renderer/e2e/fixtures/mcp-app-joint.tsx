import { createRoot } from 'react-dom/client'
import { useCallback, useEffect, useMemo, useState } from 'react'
import { reduceWorkbenchMessages } from '@wegent/chat-core'
import i18n from '../../src/i18n'
import '../../src/styles/globals.css'
import { GatewayRuntimeCore } from '../../src/kcoder/gateway/runtime/core'
import type { GatewayClient } from '../../src/kcoder/gatewayRuntimeTypes'
import { registerGatewayCommandTransport, subscribeRuntimeEvent } from '../../src/kcoder/gatewayServiceBridge'
import { ConversationWidgetsProvider } from '../../src/components/chat/widgets/ConversationWidgetsProvider'
import { MessageList } from '../../src/components/chat/MessageList'
import { RequestUserInputCard } from '../../src/components/chat/RequestUserInputCard'
import { requestUserInputResponseKeys, requestUserInputPayloadKey } from '../../src/components/chat/requestUserInputMessages'
import { pendingRequestUserInputPayload } from '../../src/components/layout/requestUserInputOverlay'
import { createRuntimeTaskStreamHandlers } from '../../src/features/workbench/runtimePaneMessages'
import { createResponseApiStreamState, emitResponseApiEvent } from '../../src/stream/responseApiStream'
import type { WidgetRequest } from '../../src/kcoder/widgetApi'
import type { LocalExecutorEvent } from '../../src/host/localExecutor'
import type { RuntimeTaskAddress, RequestUserInputResponse } from '../../src/types/api'
import type { WorkbenchMessage } from '../../src/types/workbench'

// Every RPC and receipt comes from the owned actual Gateway/app-server. This
// page supplies no native bridge, fake artifact, tool result or permission decision.
await i18n.changeLanguage('zh-CN')
async function request<T>(path: string, body?: unknown, signal?: AbortSignal): Promise<T> {
  const response = await fetch(`/__mcp_joint/${path}`, { method: body === undefined ? 'GET' : 'POST', headers: { 'x-kcoder-joint': '1', ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal })
  const value = await response.json()
  if (!response.ok || value.error) throw new Error(value.error ?? `HTTP ${response.status}`)
  return value as T
}
interface Bootstrap { thread: { id: string; studioWorkMode: 'kworker' }; workspace: string; serverId: string; taskId: string; began: boolean; history: boolean; acknowledged: { capabilities: { experimental: Record<string, unknown> } } }
const bootstrap = await request<Bootstrap>('bootstrap')
const address: RuntimeTaskAddress = { deviceId: bootstrap.serverId, taskId: bootstrap.taskId, threadId: bootstrap.thread.id, workspacePath: bootstrap.workspace, runtimeHandle: { threadId: bootstrap.thread.id, studioWorkMode: 'kworker' } }
class OwnedAdapterClient extends EventTarget implements GatewayClient {
  async connect() {}
  request<T>(method: string, params: Record<string, unknown> = {}, options?: { signal?: AbortSignal }) { return request<T>('rpc', { method, params }, options?.signal) }
  respond(id: number, result: unknown) { void request('approval', { id, result }).catch(error => { this.dispatchEvent(new CustomEvent('fixture-error', { detail: String(error.message) })) }) }
  respondError() { throw new Error('Unexpected unbound interaction error') }
  supportsExperimental(capability: string) { return bootstrap.acknowledged.capabilities.experimental[capability] === true }
  supportsThreadResume() { return true }
  close() {}
}
const client = new OwnedAdapterClient()
const server = { id: bootstrap.serverId, label: 'Owned real MCP runtime', description: 'Real app-server/Gateway', transport: 'local' as const, runtime: 'kcoder' as const, workspacePath: bootstrap.workspace }
const runtime = new GatewayRuntimeCore('', { loadServers: async () => [server], createClient: () => client })
runtime.tasks.set(bootstrap.taskId, { serverId: bootstrap.serverId, taskId: bootstrap.taskId, threadId: bootstrap.thread.id, workspacePath: bootstrap.workspace, studioWorkMode: 'kworker', title: 'Real MCP App', runtime: 'kcoder', persisted: true, running: false, createdAt: Date.now(), updatedAt: Date.now(), runtimeHandle: { threadId: bootstrap.thread.id, studioWorkMode: 'kworker' } })
runtime.threadByTask.set(bootstrap.taskId, bootstrap.thread.id)
runtime.taskByThread.set(runtime.threadKey(bootstrap.serverId, bootstrap.thread.id), bootstrap.taskId)
runtime.clientByTask.set(bootstrap.taskId, client)
registerGatewayCommandTransport((command, args) => runtime.request(command, (args ?? {}) as Record<string, unknown>))

export function Fixture() {
  const [messages, setMessages] = useState<WorkbenchMessage[]>([])
  const [answered, setAnswered] = useState<ReadonlySet<string>>(new Set())
  const [began, setBegan] = useState(bootstrap.began)
  const [error, setError] = useState('')
  const [draft, setDraft] = useState('保留已有草稿')
  const stream = useMemo(() => createResponseApiStreamState(), [])
  const handlers = useMemo(() => createRuntimeTaskStreamHandlers(address, { onMessageAction: action => setMessages(previous => reduceWorkbenchMessages(previous, action)) }), [])
  useEffect(() => {
    let cancelled = false, after = 0
    let unlisten = () => {}
    const failure = (event: Event) => setError(String((event as CustomEvent).detail))
    client.addEventListener('fixture-error', failure)
    const poll = async () => {
      unlisten = await subscribeRuntimeEvent<LocalExecutorEvent>('local-executor:event', event => emitResponseApiEvent(handlers, event.payload.event, event.payload.payload, stream))
      while (!cancelled) {
        const value = await request<{ frames: Array<{ sequence: number; frame: { id?: number; method: string; params: Record<string, unknown> } }> }>(`events?after=${after}`)
        for (const { sequence, frame } of value.frames) {
          if (cancelled) break
          after = sequence
          if (frame.id !== undefined) await runtime.forwardServerRequest(client, frame, bootstrap.serverId)
          else await runtime.forwardNotification(frame.method, frame.params, bootstrap.serverId, client)
        }
        await new Promise(resolve => setTimeout(resolve, 60))
      }
    }
    void poll().catch(cause => { if (!cancelled) setError(String(cause.message)) })
    return () => { cancelled = true; unlisten(); client.removeEventListener('fixture-error', failure) }
  }, [handlers, stream])
  const widgetRequest: WidgetRequest = useCallback(<T,>(method: string, params: Record<string, unknown>, signal?: AbortSignal) => runtime.request(method.startsWith('mcp/apps/') ? 'runtime.mcpApps.request' : 'runtime.widgets.request', { address, method, params }, { signal }) as Promise<T>, [])
  const pending = pendingRequestUserInputPayload(messages, answered)
  const submit = (response: RequestUserInputResponse) => {
    setAnswered(previous => new Set([...previous, ...requestUserInputResponseKeys(response)]))
    void runtime.request('runtime.tasks.send', { address, taskId: bootstrap.taskId, requestUserInputResponse: response }).catch(cause => setError(String(cause.message)))
  }
  return (
    <main className="mx-auto min-h-dvh max-w-4xl bg-background px-6 py-5 text-base text-text-primary">
      <div className="mb-4 flex items-center gap-3 border-b border-border pb-3">
        <button data-testid="joint-begin" disabled={began} className="rounded-md bg-primary px-3 py-2 text-primary-foreground disabled:opacity-50" onClick={() => { setBegan(true); void request('begin', {}).catch(cause => setError(String(cause.message))) }}>生成真实 MCP App</button>
        <button data-testid="joint-history" className="rounded-md border border-border px-3 py-2" onClick={() => { void request('history', {}).then(() => location.reload()).catch(cause => setError(String(cause.message))) }}>断开原所有者并查看历史</button>
        <output data-testid="joint-history-state">{bootstrap.history ? 'readonly-history' : 'live-owner'}</output>
      </div>
      <output data-testid="joint-error" className="block whitespace-pre-wrap text-destructive">{error}</output>
      <ConversationWidgetsProvider address={address} messages={messages} request={widgetRequest} onSendPrompt={text => setDraft(previous => `${previous}\n${text}`)}>
        <MessageList messages={messages} conversationKey={bootstrap.taskId} processingWindowEnabled hideRequestUserInputBlocks hiddenRequestUserInputIds={answered} />
      </ConversationWidgetsProvider>
      {pending && <div data-testid="joint-approval" className="sticky bottom-4 z-20"><RequestUserInputCard key={requestUserInputPayloadKey(pending)} payload={pending} onSubmit={submit} /></div>}
      <textarea aria-label="所属会话草稿" className="mt-4 w-full rounded-md border border-border bg-background p-3" value={draft} onChange={event => setDraft(event.target.value)} />
      <output data-testid="joint-message-statuses">{JSON.stringify(messages.map(message => ({ subtaskId: message.subtaskId, status: message.status })))}</output>
    </main>
  )
}
createRoot(document.getElementById('root')!).render(<Fixture />)
