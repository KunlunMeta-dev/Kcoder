import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { createRoot } from 'react-dom/client'
import { RequestUserInputCard } from '../../src/components/chat/RequestUserInputCard'
import type { RequestUserInputPayload } from '../../src/components/chat/RequestUserInputCard'
import {
  applyRequestUserInputResponseToMessages,
  createRequestUserInputAliasTracker,
  isHiddenRequestUserInputBlock,
  isPendingRequestUserInputBlock,
  observeRequestUserInputAliases,
  requestUserInputRelatedKeysForPayloads,
} from '../../src/components/chat/requestUserInputMessages'
import { agentInteractionSource } from '../../src/kcoder/agentInteractionSource'
import { ToolBlocksDisplay } from '../../src/components/chat/blocks/ToolBlocksDisplay'
import { forwardAcceptedNotification } from '../../src/kcoder/gateway/runtime/notifications'
import { registerGatewayCommandTransport, subscribeRuntimeEvent } from '../../src/kcoder/gatewayServiceBridge'
import type { ToolBlock } from '../../src/types/workbench'
import { respondToTaskQuestion } from '../../src/kcoder/gateway/runtime/interactions'
import { cancelTask } from '../../src/kcoder/gateway/runtime/turns'
import type { GatewayRuntimeCore } from '../../src/kcoder/gateway/runtime/core'
import { usePaneInteractions } from '../../src/components/layout/pane/usePaneInteractions'
import type { WorkbenchMessage } from '../../src/types/workbench'
import type { RequestUserInputResponse, RuntimeTaskAddress } from '../../src/types/api'
import { applyAppearance } from '../../src/features/appearance/applyAppearance'
import { defaultAppearance } from '../../src/features/appearance/presets'
import '../../src/i18n'
import '../../src/styles/globals.css'

const nativePlanId = new URLSearchParams(location.search).get('nativePlanId')
const answerRecovery = new URLSearchParams(location.search).has('answerRecovery')
const ignoreRecovery = new URLSearchParams(location.search).has('ignoreRecovery')
const cancelBinding = new URLSearchParams(location.search).get('cancelBinding')
const payload: RequestUserInputPayload = {
  kind: 'request_user_input', requestId: 41, itemId: 'question-41',
  questions: [{ id: 'choice', question: '这项任务应如何继续？', options: [{ label: '继续整理' }] }],
}
if (cancelBinding) {
  payload.threadId = 'fixture-thread'
  payload.turnId = 'original-turn'
}
if (nativePlanId) {
  payload.allowImplementationPlanShortcut = false
  payload.questions = [
    { id: nativePlanId, question: 'How should work proceed?', isOther: false,
      options: [{ label: '执行此计划' }, { label: 'Review first' }] },
    { id: 'scope', question: 'Which scope?', isOther: true, options: [] },
  ]
}
const initialMessages = [{
  id: 'question-message', role: 'assistant', content: '', status: 'streaming', createdAt: '2026-11-03',
  blocks: [{ id: 'question-41', type: 'tool', toolName: 'AskUserQuestion', status: 'pending', renderPayload: payload }],
}] as WorkbenchMessage[]

export function Fixture() {
  const [messages, setMessages] = useState(initialMessages)
  const [answered, setAnswered] = useState(new Set<string>())
  const [attempts, setAttempts] = useState(0)
  const [cancellations, setCancellations] = useState(0)
  const [interrupts, setInterrupts] = useState(0)
  const [cancellationRuntime] = useState(() => {
    // Keep the card's old address while the runtime directory has rebound it.
    const task = { serverId: 'fixture-target', threadId: 'fixture-thread', workspacePath: '/original' }
    if (cancelBinding === 'threadId' || cancelBinding === 'serverId' || cancelBinding === 'workspacePath')
      task[cancelBinding] = 'replacement'
    const client = { request: async () => { setInterrupts(value => value + 1); return { interrupted: true } } }
    return {
      disposed: false, resolveTaskId: (id: string) => id,
      tasks: new Map([['fixture-task', task]]),
      threadByTask: new Map([['fixture-task', task.threadId]]),
      clientByTask: new Map([['fixture-task', client]]),
      activeTurnByTask: new Map([['fixture-task', { turnId: cancelBinding === 'original' ? 'original-turn' : 'replacement-turn' }]]),
      appServerDisconnectedClients: new WeakSet(),
    } as unknown as GatewayRuntimeCore
  })
  const [accept, setAccept] = useState(false)
  const [lastResponse, setLastResponse] = useState<RequestUserInputResponse>()
  const pendingAnswer = useRef<((accepted: boolean) => void) | null>(null)
  const pendingCancel = useRef<((cancelled: boolean) => void) | null>(null)
  const messagesRef = useRef(messages)
  useLayoutEffect(() => { messagesRef.current = messages }, [messages])
  const [aliasTracker] = useState(() => ({ ...createRequestUserInputAliasTracker(), previousPayloads: [payload] }))
  const tracker = useRef(aliasTracker)
  const pane = usePaneInteractions({
    currentRuntimeTask: { runtime: 'kcoder', deviceId: 'fixture-target', taskId: 'fixture-task', threadId: 'fixture-thread', workspacePath: '/original' },
    projectChat: { setSelectedModelOption() {} },
    sendRuntimePaneMessage: async (request: { requestUserInputResponse?: RequestUserInputResponse }) => {
      setAttempts(value => value + 1)
      setLastResponse(request.requestUserInputResponse)
      if (answerRecovery) return new Promise<boolean>(resolve => { pendingAnswer.current = resolve })
      return accept
    },
    editLastUserMessage: async () => false,
    cancelRuntimePaneTask: async (address: RuntimeTaskAddress) => {
      setCancellations(value => value + 1)
      if (cancelBinding) return (await cancelTask.call(cancellationRuntime, { ...address })).accepted
      if (ignoreRecovery) return new Promise<boolean>(resolve => { pendingCancel.current = resolve })
      return false
    },
    setError() {},
    dispatchMessages() {},
    paneStatus: { isBusy: false },
    getRuntimeModelFields: () => ({}),
    requestUserInputAliasTrackerRef: tracker,
    updateAnsweredRequestUserInputIds: setAnswered,
    messagesRef,
    applyLocalRequestUserInputResponse: (response: RequestUserInputResponse) => setMessages(current => applyRequestUserInputResponseToMessages(current, response)),
  } as unknown as Parameters<typeof usePaneInteractions>[0])
  const currentBlock = messages[0].blocks?.[0]
  const pending = currentBlock && isPendingRequestUserInputBlock(currentBlock, answered)
  return <main className="mx-auto flex max-w-xl flex-col gap-3 p-4">
    <p data-testid="fixture-boundary">受控发送结果 fixture · 不连接 Gateway、Native 或模型</p>
    <textarea aria-label="普通对话草稿" className="rounded-xl border border-border p-3" />
    <p data-testid="send-attempts">{attempts}</p>
    <p data-testid="cancel-attempts">{cancellations}</p>
    {cancelBinding && <output data-testid="cancel-wire-count">{interrupts}</output>}
    <p data-testid="answered-count">{answered.size}</p>
    {(nativePlanId || answerRecovery) && <output data-testid="submitted-response">{JSON.stringify(lastResponse)}</output>}
    {(answerRecovery || ignoreRecovery) && <button data-testid="restore-in-flight" onClick={() => {
      const restored = { ...payload, requestId: undefined, itemId: 'restored-item' }
      observeRequestUserInputAliases(tracker.current, [restored, payload])
      setMessages([{ ...initialMessages[0], blocks: [{ ...initialMessages[0].blocks![0], renderPayload: restored }] }])
    }}>刷新恢复原问题</button>}
    <button data-testid="accept-next-send" onClick={() => {
      if (pendingCancel.current) pendingCancel.current(true)
      else if (pendingAnswer.current) pendingAnswer.current(true)
      else setAccept(true)
    }}>允许下一次发送</button>
    {ignoreRecovery && <button data-testid="reject-cancellation" onClick={() => pendingCancel.current?.(false)}>保留原问题</button>}
    {pending && <RequestUserInputCard payload={currentBlock.renderPayload as RequestUserInputPayload} aliasesByKey={aliasTracker.aliasesByKey} autoSubmitOnOptionSelect={nativePlanId ? undefined : false}
      onSubmit={pane.sendRequestUserInputResponse} onIgnore={() => void pane.ignoreRequestUserInput(currentBlock.renderPayload as RequestUserInputPayload)} />}
    {!pending && <p data-testid="question-confirmed">回答发送已确认</p>}
  </main>
}

function RestorationFixture({ difference }: { difference: string }) {
  const [hidden, setHidden] = useState(new Set<string>())
  const restored: RequestUserInputPayload[] = ['a', 'b'].map(id => ({
    kind: 'request_user_input', itemId: `restored-${id}`,
    questions: [{ id: 'choice', question: 'Continue?',
      isOther: difference === 'option' || difference === 'partial' || id === 'a',
      options: [{ id: difference === 'option' ? id : 'yes', label: 'Yes' }] }],
  }))
  const live = restored.map((payload, index) => ({
    ...payload, requestId: index + 1, itemId: `live-${index + 1}`,
  }))
  const tracker = createRequestUserInputAliasTracker()
  observeRequestUserInputAliases(tracker, restored)
  observeRequestUserInputAliases(tracker, difference === 'partial' ? [live[1]] : [live[1], live[0]])
  return <main className="mx-auto flex max-w-xl flex-col gap-3 p-4">
    <p data-testid="fixture-boundary">受控恢复与跨端回答 fixture · 不连接 Gateway、Native 或模型</p>
    <textarea aria-label="普通对话草稿" className="rounded-xl border border-border p-3" />
    <button data-testid="confirm-second-question" onClick={() => setHidden(new Set(
      requestUserInputRelatedKeysForPayloads(tracker.previousPayloads, {
        requestId: live[1].requestId, itemId: live[1].itemId, answers: {},
      }, tracker.aliasesByKey)
    ))}>确认另一端已回答第二题</button>
    {restored.map(renderPayload => !isHiddenRequestUserInputBlock({
      id: renderPayload.itemId!, type: 'tool', toolName: 'AskUserQuestion', status: 'pending', renderPayload,
    }, hidden) && <section key={renderPayload.itemId} data-testid={renderPayload.itemId}>
      <RequestUserInputCard payload={renderPayload} autoSubmitOnOptionSelect={false}
        focusOnMount={false} onSubmit={() => false} />
    </section>)}
  </main>
}

function ReusedAliasFixture({ reused }: { reused: string }) {
  const [hidden, setHidden] = useState(new Set<string>())
  const [attempts, setAttempts] = useState(0)
  const restored = { ...payload, requestId: undefined, itemId: 'restored' }
  const original = { ...payload, itemId: 'original' }
  const sibling = reused === 'request'
    ? { ...original, itemId: 'sibling' } : { ...original, requestId: 42 }
  const tracker = createRequestUserInputAliasTracker()
  observeRequestUserInputAliases(tracker, [restored])
  observeRequestUserInputAliases(tracker, [original])
  observeRequestUserInputAliases(tracker, [original, sibling])
  const confirm = (response: RequestUserInputResponse) => setHidden(current => new Set([
    ...current, ...requestUserInputRelatedKeysForPayloads(
      tracker.previousPayloads, response, tracker.aliasesByKey),
  ]))
  return <main className="mx-auto flex max-w-xl flex-col gap-3 p-4">
    <p data-testid="fixture-boundary">受控身份复用 fixture · 不连接 Gateway、Native 或模型</p>
    <textarea aria-label="普通对话草稿" className="rounded-xl border border-border p-3" />
    <p data-testid="send-attempts">{attempts}</p>
    <button data-testid="confirm-partial" onClick={() => confirm(reused === 'request'
      ? { requestId: original.requestId, answers: {} }
      : { itemId: original.itemId, answers: {} })}>读取部分身份回答</button>
    <button data-testid="confirm-sibling" onClick={() => confirm({
      requestId: sibling.requestId, itemId: sibling.itemId, answers: {},
    })}>读取第二题完整回答</button>
    {[restored, sibling].map((renderPayload, index) => !isHiddenRequestUserInputBlock({
      id: `question-${index}`, type: 'tool', toolName: 'AskUserQuestion', status: 'pending', renderPayload,
    }, hidden) && <section key={index} data-testid={`reused-question-${index}`}>
      <RequestUserInputCard payload={renderPayload} autoSubmitOnOptionSelect={false}
        focusOnMount={false} onSubmit={() => { setAttempts(value => value + 1); return false }} />
    </section>)}
  </main>
}

function SourceBoundQuestionFixture() {
  const [wireCount, setWireCount] = useState(0)
  const [resultCode, setResultCode] = useState('')
  const sourceAgent = agentInteractionSource({
    parentSessionId: 'fixture-thread', agentId: 'child',
    backgroundRun: { parentSessionId: 'fixture-thread', agentId: 'child', runId: 'original-run' },
  }, 'fixture-thread')
  const child = { ...payload, sourceAgent }
  const [runtime] = useState(() => {
    // Exercise the real renderer response path against an isolated wire sink.
    const client = { supportsExperimental: () => true,
      respond: () => setWireCount(count => count + 1) }
    return {
      disposed: false, appServerDisconnectedClients: new WeakSet(),
      clientByTask: new Map([['fixture-task', client]]),
      threadByTask: new Map([['fixture-task', 'fixture-thread']]),
      tasks: new Map([['fixture-task', { serverId: 'fixture-target' }]]),
      pendingQuestionByKey: new Map([['fixture-task\0' + 41, {
        taskId: 'fixture-task', turnId: 'original-turn', requestId: 41,
        questionId: 'question-41', client, renderPayload: child,
      }]]),
    } as unknown as GatewayRuntimeCore
  })
  const submit = async (response: RequestUserInputResponse) => {
    const result = await respondToTaskQuestion.call(runtime, 'fixture-task', response)
    setResultCode(result.accepted ? 'accepted' : result.code ?? 'rejected')
    return result.accepted
  }
  return <main className="mx-auto flex max-w-xl flex-col gap-3 p-4">
    <p data-testid="fixture-boundary">受控原来源回答 fixture · 不连接 Gateway、Native 或模型</p>
    <textarea aria-label="普通对话草稿" className="rounded-xl border border-border p-3" />
    <output data-testid="source-wire-count">{wireCount}</output>
    <output data-testid="source-answer-code">{resultCode}</output>
    <section data-testid="stale-parent-question">
      <RequestUserInputCard payload={payload} autoSubmitOnOptionSelect={false}
        focusOnMount={false} onSubmit={submit} />
    </section>
    <section data-testid="original-child-question">
      <RequestUserInputCard payload={child} autoSubmitOnOptionSelect={false}
        focusOnMount={false} onSubmit={submit} />
    </section>
  </main>
}

function ViewerResolutionFixture({ kind }: { kind: string }) {
  const [block, setBlock] = useState(() => ({ ...initialMessages[0].blocks![0],
    renderPayload: { ...payload, threadId: 'thread', turnId: 'turn', appServerEpoch: 'epoch',
      ...(kind === 'approval' ? { itemId: 'approval-41', approvalPresentation: {
        kind: 'command', subject: 'echo controlled',
      } } : {}) },
  }) as ToolBlock)
  const [wireCount, setWireCount] = useState(0)
  const [runtime] = useState(() => {
    const client = { respond: () => setWireCount(count => count + 1) }
    return {
      disposed: false, appServerDisconnectedClients: new WeakSet(),
      tasks: new Map([['task', { serverId: 'target', threadId: 'thread' }]]),
      clientByTask: new Map([['task', client]]), taskByThread: new Map([['target\0thread', 'task']]),
      threadKey: (server: string, thread: string) => `${server}\0${thread}`,
      remoteSessions: { handleNotification: () => false },
      pendingQuestionByKey: new Map([['task\0' + 41, {
        client, taskId: 'task', requestId: 41, turnId: 'turn', appServerEpoch: 'epoch', block,
        renderPayload: block.renderPayload,
        ...(kind === 'approval' ? { approvalId: 'approval-41' } : { questionId: 'question-41' }),
      }]]),
    } as unknown as GatewayRuntimeCore
  })
  useEffect(() => {
    const unregister = registerGatewayCommandTransport(() => undefined)
    const stop = subscribeRuntimeEvent<{ payload: { data: { updates: Partial<ToolBlock> } } }>(
      'local-executor:event', event => setBlock(current => ({ ...current, ...event.payload.payload.data.updates })))
    return () => { void stop.then(dispose => dispose()); unregister() }
  }, [])
  return <main className="mx-auto flex max-w-xl flex-col gap-3 p-4">
    <textarea aria-label="普通对话草稿" />
    <output data-testid="viewer-wire-count">{wireCount}</output>
    <button data-testid="peer-resolution" onClick={() => void forwardAcceptedNotification.call(
      runtime, `${kind}/resolved`, { requestId: 41, threadId: 'thread', turnId: 'turn',
        appServerEpoch: 'epoch', reason: 'client_response',
        ...(kind === 'approval' ? { approvalId: 'approval-41', decision: 'accept' } : { questionId: 'question-41' }),
      }, 'target', runtime.clientByTask.get('task'))}>读取原终态回执</button>
    <output data-testid="viewer-overlay-pending">{String(isPendingRequestUserInputBlock(block))}</output>
    <ToolBlocksDisplay blocks={[block]} isStreaming />
  </main>
}

const sourceRequired = new URLSearchParams(window.location.search).has('sourceRequired')
const difference = new URLSearchParams(window.location.search).get('restoration')
const reused = new URLSearchParams(window.location.search).get('aliasReuse')
const theme = window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'
applyAppearance({ ...defaultAppearance, mode: theme }, theme)
const peerResolved = new URLSearchParams(window.location.search).get('peerResolved')
createRoot(document.getElementById('root')!).render(peerResolved ? <ViewerResolutionFixture kind={peerResolved} /> : sourceRequired ? <SourceBoundQuestionFixture /> : reused ? <ReusedAliasFixture reused={reused} /> : difference
  ? <RestorationFixture difference={difference} /> : <Fixture />)
