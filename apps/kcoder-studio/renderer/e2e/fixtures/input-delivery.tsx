import { useLayoutEffect, useMemo, useRef, useState } from 'react'
import { createRoot } from 'react-dom/client'
import { reduceWorkbenchMessages } from '@wegent/chat-core'
import { useWorkbenchRuntimeMessaging } from '../../src/features/workbench/useWorkbenchRuntimeMessaging'
import { BufferedChatInput } from '../../src/components/layout/BufferedChatInput'
import { ComposerStatusRegion } from '../../src/components/chat/composer/ComposerStatusRegion'
import { usePaneSend } from '../../src/components/layout/pane/usePaneSend'
import { usePaneQueueControls } from '../../src/components/layout/pane/usePaneQueueControls'
import { inputDelivery } from '../../src/kcoder/gateway/runtime/inputDelivery'
import type { GatewayRuntimeCore } from '../../src/kcoder/gateway/runtime/core'
import {
  cacheRuntimeConversationQueuedMessagesByKey,
  runtimeConversationKey,
} from '../../src/features/workbench/runtimeConversationCache'
import { registerGatewayCommandTransport } from '../../src/kcoder/gatewayServiceBridge'
import { defaultAppPreferences } from '../../src/host/appPreferences'
import { applyAppearance } from '../../src/features/appearance/applyAppearance'
import { defaultAppearance } from '../../src/features/appearance/presets'
import { createRandomUuid } from '../../src/lib/random-id'
import type { WorkbenchMessage, RuntimePaneQueuedMessage } from '../../src/types/workbench'
import i18n from '../../src/i18n'
import '../../src/styles/globals.css'

const interruptScene = new URLSearchParams(location.search).has('interrupt')
let replacementAttempts = 0
const address = {
  deviceId: 'delivery-fixture',
  taskId: 'task',
  threadId: 'thread',
  workspacePath: '/fixture',
}
const task = {
  taskId: address.taskId,
  serverId: address.deviceId,
  threadId: address.threadId,
  workspacePath: address.workspacePath,
}
const receipts = new Map<string, { threadId: string; turnId: string; status: string }>()
const requests: string[] = []
let activeTurn: string | null = null
let interruptCount = 0
let pending: { id: string; finish: (accepted: boolean) => void } | null = null
let renderMetrics = () => {}
const client = {
  supportsExperimental: () => true,
  request: async (method: string, params: Record<string, unknown>) => {
    if (method === 'turn/receipt/read')
      return { receipt: receipts.get(String(params.clientMessageId)) ?? null }
    if (method === 'turn/interrupt') {
      const interrupted = activeTurn === params.turnId
      if (interrupted) {
        interruptCount++
        for (const receipt of receipts.values())
          if (receipt.turnId === params.turnId) receipt.status = 'interrupted'
        activeTurn = null
      }
      renderMetrics()
      return { interrupted }
    }
    throw new Error(`Unexpected controlled RPC ${method}`)
  },
}
const core = {
  tasks: new Map([[task.taskId, task]]),
  clientByTask: new Map([[task.taskId, client]]),
  appServerDisconnectedClients: new Set(),
  resolveTaskId: (id: string) => id,
  taskConnection: async () => ({ taskId: task.taskId, task, client }),
} as unknown as GatewayRuntimeCore
registerGatewayCommandTransport(async (command, raw) => {
  if (command === 'get_app_preferences') return defaultAppPreferences
  const args = raw as { method?: string; params?: Record<string, unknown> }
  if (command === 'local_executor_request' && args.method === 'runtime.input.delivery')
    return inputDelivery(core, args.params ?? {})
  throw new Error(`Unexpected fixture command ${command}`)
})
await i18n.changeLanguage('zh-CN')

export function App() {
  const [rows, setRows] = useState<RuntimePaneQueuedMessage[]>([])
  const [input, setInput] = useState('')
  const [messages, setMessages] = useState<WorkbenchMessage[]>([])
  const interruptInFlight = useRef(false)
  const pendingGuidances = useRef(new Map())
  const interruptedGuidances = useRef(new Set<string>())
  const [error, setError] = useState<string | null>(null)
  const [, redraw] = useState(0)
  const scopeInvalidated = useRef(false)
  const taskRef = useRef(address)
  const inFlight = useRef(new Set<string>())
  const lastRetry = useRef(null)
  const projectChat = useMemo(() => ({ models: [], addExistingAttachment: () => {} }), [])
  useLayoutEffect(() => {
    renderMetrics = () => redraw(value => value + 1)
    applyAppearance({ ...defaultAppearance, mode: 'dark' }, 'dark')
    return () => {
      renderMetrics = () => {}
    }
  }, [])
  // Keep the fixture's state setter stable, just like usePaneState's scoped setter.
  const rowsRef = useRef(rows)
  useLayoutEffect(() => {
    rowsRef.current = rows
  }, [rows])
  const setQueuedMessages = useMemo(
    () => (update: (rows: RuntimePaneQueuedMessage[]) => RuntimePaneQueuedMessage[]) => {
      const updated = update(rowsRef.current)
      rowsRef.current = updated
      cacheRuntimeConversationQueuedMessagesByKey(runtimeConversationKey(address), updated)
      setRows(updated)
    },
    []
  )
  const messaging = useWorkbenchRuntimeMessaging({
    state: {}, services: {}, runtimeTasks: {}, attachmentSelection: { attachments: [] },
    modelSelection: {}, skillSelection: { selectedSkills: [] }, refreshWorkLists: async () => {},
    lifecycleStore: { sendRequested() {}, sendAccepted() {}, sendRejected() {} },
    executorClient: { runtime: { interruptAndSendRuntimeMessage: async (request: { clientMessageId: string; message: string }) => {
      replacementAttempts++
      renderMetrics()
      if (replacementAttempts === 1) return { accepted: false, taskId: address.taskId,
        error: '等待 KCoder app-server 中断任务超时' }
      requests.push(request.clientMessageId)
      activeTurn = 'replacement-turn'
      receipts.set(request.clientMessageId, { threadId: address.threadId, turnId: activeTurn, status: 'running' })
      setMessages(current => reduceWorkbenchMessages(current, { type: 'user_added', message: {
        id: request.clientMessageId, role: 'user', content: request.message, status: 'done',
        taskId: address.taskId, turnId: activeTurn!, createdAt: new Date().toISOString(),
      } }) as WorkbenchMessage[])
      return { accepted: true, taskId: address.taskId }
    } } },
  } as unknown as Parameters<typeof useWorkbenchRuntimeMessaging>[0])
  const context = {
    interruptAndSendInFlightRef: interruptInFlight,
    pendingAppliedGuidancesRef: pendingGuidances,
    interruptedGuidanceIdsRef: interruptedGuidances,
    interruptAndSendRuntimePaneMessage: messaging.interruptAndSendRuntimePaneMessage,
    setMessages,
    currentRuntimeTask: address,
    currentRuntimeTaskRef: taskRef,
    accountScopeInvalidatedRef: scopeInvalidated,
    queuedMessageSendInFlightIdsRef: inFlight,
    lastSubmittedRetryMessageRef: lastRetry,
    projectChat,
    setQueuedMessages,
    setError,
    dispatchMessages: (action: Parameters<typeof reduceWorkbenchMessages>[1]) =>
      setMessages(current => reduceWorkbenchMessages(current, action) as WorkbenchMessage[]),
    queuedMessages: rows,
    input,
    setInput,
    setCodeCommentContexts: () => {},
    sendRuntimePaneMessage: async (request: { clientMessageId: string }) => {
      requests.push(request.clientMessageId)
      renderMetrics()
      return new Promise<boolean>(finish => {
        pending = { id: request.clientMessageId, finish }
      })
    },
  }
  const sending = usePaneSend(context as unknown as Parameters<typeof usePaneSend>[0])
  const controls = usePaneQueueControls({
    ...context,
    refreshQueuedDelivery: sending.refreshQueuedDelivery,
  } as unknown as Parameters<typeof usePaneQueueControls>[0])
  const accept = (acknowledged: boolean) => {
    if (!pending) return
    const value = pending
    pending = null
    activeTurn = 'original-turn'
    receipts.set(value.id, { threadId: address.threadId, turnId: activeTurn, status: 'running' })
    value.finish(acknowledged)
    renderMetrics()
  }
  return (
    <main className="mx-auto max-w-3xl p-4 text-text-primary">
      <p className="mb-4 text-sm text-text-muted">
        消息交付验收 · 受控 app-server fixture，不连接真实目标或模型
      </p>
      <div className="mb-4 flex flex-wrap gap-2">
        <button data-testid="delivery-accept" onClick={() => accept(true)}>
          确认接收
        </button>
        <button data-testid="delivery-lost-ack" onClick={() => accept(false)}>
          接收但丢失应答
        </button>
        <button
          data-testid="delivery-complete-next"
          onClick={() => {
            if (pending) {
              const value = pending
              pending = null
              receipts.set(value.id, {
                threadId: address.threadId,
                turnId: 'original-turn',
                status: 'completed',
              })
              value.finish(true)
            }
            for (const receipt of receipts.values()) receipt.status = 'completed'
            activeTurn = 'next-turn'
            renderMetrics()
          }}
        >
          完成并开始下一回合
        </button>
      </div>
      <output data-testid="delivery-send-count">{requests.length}</output>
      <output data-testid="delivery-interrupt-count">{interruptCount}</output>
      <output data-testid="delivery-active-turn">{activeTurn ?? 'none'}</output>
      {interruptScene && <div data-testid="delivery-transcript">
        {messages.map(message => <p key={message.id} data-testid="delivery-user-message">{message.content}</p>)}
      </div>}
      <ComposerStatusRegion ownerKey="fixture">
        <BufferedChatInput
          variant="desktop"
          isStreaming={interruptScene}
          value={input}
          onChange={setInput}
          disabled={false}
          showProjectWorkBar={false}
          queuedMessages={rows}
          onCancelQueuedMessage={controls.cancelQueuedMessage}
          onInterruptAndSendQueuedMessage={id => {
            const row = rowsRef.current.find(message => message.id === id)
            if (row) void sending.interruptAndSendQueuedMessage(row)
          }}
          error={error}
          onSubmit={(value, options) => {
            const content = (value ?? input).trim()
            if (!content) return
            setInput('')
            const send = options?.interruptWhenBusy
              ? sending.interruptAndSendQueuedMessage : sending.sendRuntimeMessage
            void send({
              id: createRandomUuid(),
              content,
              createdAt: new Date().toISOString(),
              status: 'queued',
            })
          }}
        />
      </ComposerStatusRegion>
    </main>
  )
}
createRoot(document.getElementById('root')!).render(<App />)
