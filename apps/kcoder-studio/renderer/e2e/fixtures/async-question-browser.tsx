import { Fragment, useLayoutEffect, useState } from 'react'
import { createRoot } from 'react-dom/client'
import type {
  AsyncQuestionAnswerValue,
  AsyncQuestionRecord,
} from '../../../shared/generated/contracts'
import { AsyncQuestionPanel } from '../../src/components/chat/AsyncQuestionPanel'
import { BufferedChatInput } from '../../src/components/layout/BufferedChatInput'
import { ComposerStatusRegion } from '../../src/components/chat/composer/ComposerStatusRegion'
import { RequestUserInputCard } from '../../src/components/chat/RequestUserInputCard'
import { Button } from '../../src/components/ui/button'
import { applyAppearance } from '../../src/features/appearance/applyAppearance'
import { defaultAppearance } from '../../src/features/appearance/presets'
import {
  registerGatewayCommandTransport,
  emitRuntimeEvent,
} from '../../src/kcoder/gatewayServiceBridge'
import { LOCAL_EXECUTOR_EVENT } from '../../src/host/localExecutor'
import { defaultAppPreferences } from '../../src/host/appPreferences'
import type { RuntimeGoal, RuntimeTaskAddress } from '../../src/types/api'
import type { QueuedWorkbenchMessage } from '../../src/types/workbench'
import i18n from '../../src/i18n'
import '../../src/styles/globals.css'

const task: RuntimeTaskAddress = {
  taskId: 'e2e-async-question:task-a',
  deviceId: 'e2e-async-question-target',
  threadId: 'e2e-async-question-thread',
}

const alternateTask: RuntimeTaskAddress = {
  ...task,
  taskId: 'e2e-async-question:task-b',
  threadId: 'e2e-async-question-thread-b',
}
const retryRace = new URLSearchParams(location.search).has('retryRace')
const answerRace = new URLSearchParams(location.search).has('answerRace')
const lostAnswerReceipt = new URLSearchParams(location.search).has('lostAnswerReceipt')
const initialList = new URLSearchParams(location.search).get('initialList')
const unifiedStatus = new URLSearchParams(location.search).has('statusRegion')
const scene = new URLSearchParams(location.search).get('scene') ?? 'busy'
const pendingCreationScene = scene === 'creating'
let rejectHeldAnswer: ((reason: Error) => void) | null = null
let recoveredCapability: boolean | 'error' = true
let capabilityAttempts = 0
let finishCapabilityRetry: (() => void) | null = null

const fixtureRuntime = {
  question: {
    questionId: 'e2e-question-a',
    requestId: 'e2e-request-a',
    threadId: task.threadId!,
    sourceTurnId: 'e2e-source-turn-a',
    toolCallId: 'e2e-tool-call-a',
    revision: new URLSearchParams(location.search).has('olderNotifications') ? 3 : 1,
    createdAtMs: 1,
    status: 'pending',
    questions: [
      {
        id: new URLSearchParams(location.search).get('itemId') ?? 'e2e-item-a',
        header: '处理方式',
        question: '这项任务应如何继续？',
        multiSelect: new URLSearchParams(location.search).get('multiSelect') === '1',
        options: new URLSearchParams(location.search).has('freeform') ? [] : [
          { id: 'e2e-option-a', label: '先整理现有材料', description: '继续前归纳当前事实' },
          { id: 'e2e-option-b', label: '直接生成草稿', description: '先产出一份可检查的草稿' },
        ],
      },
    ],
  } as AsyncQuestionRecord,
  answerRequests: [] as Array<Record<string, unknown>>,
  listCalls: 0,
  completedListCalls: 0,
  capabilityCalls: 0,
  additionalQuestions: [] as AsyncQuestionRecord[],
}

const longLayout = new URLSearchParams(location.search).has('long')
if (longLayout) {
  const item = fixtureRuntime.question.questions[0]
  fixtureRuntime.question.questions = Array.from({ length: 3 }, (_, index) => ({
    ...item,
    id: `e2e-long-item-${index}`,
    header: `偏好 ${index + 1}`,
    question: '你希望这项工作采用哪种方式？不依赖回答的工作仍可继续。',
    options: Array.from({ length: 4 }, (_, option) => ({
      id: `e2e-long-option-${index}-${option}`,
      label: `处理方式 ${option + 1}`,
      description: '先完成已经明确的部分，并保留当前任务、对话历史和未发送草稿。',
    })),
  }))
}

function object(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {}
}

let holdNextList = initialList === 'empty' || initialList === 'questions'
let releaseHeldList: (() => void) | null = null

const unregisterTransport = registerGatewayCommandTransport(async (command, rawArgs) => {
  if (command === 'get_app_preferences') return defaultAppPreferences
  if (command !== 'local_executor_request') {
    throw new Error(`The browser fixture does not provide ${command}`)
  }
  const request = object(rawArgs)
  const method = request.method
  const params = object(request.params)
  const selectedTask = params.taskId === alternateTask.taskId ? alternateTask : task
  if (method === 'runtime.asyncQuestion.supports') {
    fixtureRuntime.capabilityCalls += 1
    if (recoveredCapability === 'error') throw new Error('Fixture capability read unavailable')
    if (!recoveredCapability) return { supported: false, threadId: selectedTask.threadId }
    if (unifiedStatus && scene === 'unsupported') return { supported: false }
    if (unifiedStatus && scene === 'initial-error' && fixtureRuntime.capabilityCalls === 1)
      throw new Error('Fixture task connection is not ready')
    if (retryRace && selectedTask === task) {
      capabilityAttempts += 1
      if (capabilityAttempts === 1) throw new Error('Fixture initial capability read failed')
      if (capabilityAttempts === 2) {
        await new Promise<void>(resolve => { finishCapabilityRetry = resolve })
        return { taskId: task.taskId, threadId: task.threadId, supported: false }
      }
    }
    return { taskId: selectedTask.taskId, threadId: selectedTask.threadId, supported: true }
  }
  if (method !== 'runtime.asyncQuestion.request') {
    throw new Error(`The browser fixture does not provide runtime method ${String(method)}`)
  }
  if (params.taskId !== task.taskId && (!(retryRace || answerRace) || params.taskId !== alternateTask.taskId))
    throw new Error('The fixture task owner did not match')
  if (params.method === 'asyncQuestion/list') {
    fixtureRuntime.listCalls += 1
    if (unifiedStatus && scene === 'list-error' && fixtureRuntime.listCalls === 1)
      throw new Error('Fixture first question list read failed')
    const result = { threadId: selectedTask.threadId,
      questions: initialList === 'empty' || (unifiedStatus && ['normal', 'creating', 'initial-error', 'list-error'].includes(scene))
        ? []
        : [fixtureRuntime.question, ...fixtureRuntime.additionalQuestions]
          .map(question => ({ ...question, threadId: selectedTask.threadId! })) }
    if (holdNextList) {
      holdNextList = false
      await new Promise<void>(resolve => { releaseHeldList = resolve })
    }
    fixtureRuntime.completedListCalls += 1
    return result
  }
  if (params.method === 'asyncQuestion/answer') {
    const answerParams = object(params.params)
    if (answerParams.threadId !== undefined && answerParams.threadId !== task.threadId)
      throw new Error('The fixture answer thread did not match')
    const current = [fixtureRuntime.question, ...fixtureRuntime.additionalQuestions]
      .find(question => question.questionId === answerParams.questionId)
    if (!current || answerParams.expectedRevision !== current.revision)
      throw new Error('The fixture answer revision did not match')
    fixtureRuntime.answerRequests.push(answerParams)
    if (answerRace) await new Promise<never>((_resolve, reject) => { rejectHeldAnswer = reject })
    const updated: AsyncQuestionRecord = {
      ...current,
      revision: current.revision + 1,
      status: 'answer_saved',
      answer: current.answer ?? {
        submissionId: String(answerParams.submissionId),
        answers: object(answerParams.answers) as Record<string, AsyncQuestionAnswerValue>,
        acceptedAtMs: Date.now(),
      },
    }
    const malformedEnvelope = new URLSearchParams(location.search).get('malformedAnswerEnvelope')
    if (malformedEnvelope === 'accepted' || malformedEnvelope === 'duplicate') return {
      threadId: task.threadId, accepted: true, duplicate: false, question: updated,
      [malformedEnvelope]: malformedEnvelope === 'accepted' ? 'true' : null,
    }
    if (new URLSearchParams(location.search).has('answerReceiptMismatch')) return {
      threadId: task.threadId, accepted: true, duplicate: false,
      question: { ...updated, answer: { ...updated.answer!, submissionId: 'mismatched-submission' } },
    }
    const answerTurn = new URLSearchParams(location.search).get('answerTurn')
    if (['foreign', 'alias', 'empty', 'blank'].includes(answerTurn ?? '')) return {
      threadId: task.threadId, accepted: true, duplicate: false, question: updated,
      startedTurn: { id: answerTurn === 'empty' ? '' : answerTurn === 'blank' ? '   ' : 'answer-turn',
        status: 'running', threadId: answerTurn === 'foreign' ? 'other-task' : task.threadId,
        ...(answerTurn === 'alias' ? { turnId: 'peer-turn' } : {}) },
    }
    if (current.questionId === fixtureRuntime.question.questionId) fixtureRuntime.question = updated
    else fixtureRuntime.additionalQuestions = fixtureRuntime.additionalQuestions.map(question =>
      question.questionId === updated.questionId ? updated : question)
    if (lostAnswerReceipt) throw new Error('Fixture answer saved but transport receipt lost')
    return {
      threadId: task.threadId,
      question: updated,
      accepted: true,
      duplicate: false,
      ...(answerTurn === 'legacy' ? { startedTurn: { id: 'answer-turn', status: 'running' } } : {}),
    }
  }
  throw new Error(`The browser fixture does not provide ${String(params.method)}`)
})
window.addEventListener('pagehide', unregisterTransport, { once: true })

async function emitChanged(revision?: number) {
  if (revision === undefined) fixtureRuntime.question = {
    ...fixtureRuntime.question,
    revision: fixtureRuntime.question.revision + 1,
    status: 'queued',
    // Queued state requires a persisted answer, including when another client submitted it.
    answer: fixtureRuntime.question.answer ?? {
      submissionId: 'fixture-notification-answer',
      acceptedAtMs: Date.now(),
      answers: Object.fromEntries(fixtureRuntime.question.questions.map(item => [item.id, {
        selectedOptionIds: item.options.length ? [item.options[0].id] : [],
        text: 'Fixture externally saved answer',
      }])),
    },
  }
  await emitRuntimeEvent(LOCAL_EXECUTOR_EVENT, {
    event: 'async-question:changed',
    payload: {
      taskId: task.taskId,
      serverId: task.deviceId,
      threadId: task.threadId,
      questionId: fixtureRuntime.question.questionId,
      revision: revision ?? fixtureRuntime.question.revision,
    },
  })
}

async function appendQuestion() {
  const index = fixtureRuntime.additionalQuestions.length + 1
  const questionId = `e2e-question-next-${index}`
  fixtureRuntime.additionalQuestions.push({
    ...fixtureRuntime.question,
    questionId,
    requestId: `e2e-request-next-${index}`,
    toolCallId: `e2e-call-next-${index}`,
    sourceTurnId: `e2e-turn-next-${index}`,
    revision: 1,
    createdAtMs: index + 1,
    status: 'pending',
    answer: null,
    questions: [{
      id: `e2e-next-item-${index}`,
      header: `后续提问 ${index}`,
      question: '后续工作先检查哪个主题？',
      multiSelect: false,
      options: [
        { id: `e2e-next-light-${index}`, label: '浅色主题', description: '检查浅色布局' },
        { id: `e2e-next-dark-${index}`, label: '深色主题', description: '检查深色布局' },
      ],
    }],
  })
  await emitRuntimeEvent(LOCAL_EXECUTOR_EVENT, {
    event: 'async-question:changed',
    payload: {
      taskId: task.taskId, serverId: task.deviceId, threadId: task.threadId,
      questionId, revision: 1,
    },
  })
}

declare global {
  interface Window {
    __asyncQuestionBrowserFixture: {
      answerRequests: Array<Record<string, unknown>>
      emitRecovery: (capability: boolean | 'error') => Promise<void>
      emitChanged: (revision?: number) => Promise<void>
      appendQuestion: () => Promise<void>
      listCalls: () => number
      completedListCalls: () => number
      capabilityCalls: () => number
      holdNextList: () => void
      releaseHeldList: () => void
      releaseCapabilityRetry: () => void
      rejectHeldAnswer: () => void
    }
  }
}

window.__asyncQuestionBrowserFixture = {
  rejectHeldAnswer: () => {
    if (!rejectHeldAnswer) throw new Error('No fixture answer is held')
    rejectHeldAnswer(new Error('Fixture old answer transport disconnected'))
    rejectHeldAnswer = null
  },
  releaseCapabilityRetry: () => {
    if (!finishCapabilityRetry) throw new Error('No fixture capability retry is held')
    finishCapabilityRetry()
    finishCapabilityRetry = null
  },
  answerRequests: fixtureRuntime.answerRequests,
  emitRecovery: async capability => {
    recoveredCapability = capability
    await emitRuntimeEvent(LOCAL_EXECUTOR_EVENT, {
      event: 'async-question:refresh',
      payload: { taskId: task.taskId, serverId: task.deviceId, threadId: task.threadId },
    })
  },
  emitChanged,
  appendQuestion,
  listCalls: () => fixtureRuntime.listCalls,
  completedListCalls: () => fixtureRuntime.completedListCalls,
  capabilityCalls: () => fixtureRuntime.capabilityCalls,
  holdNextList: () => { holdNextList = true },
  releaseHeldList: () => {
    if (!releaseHeldList) throw new Error('No fixture list read is held')
    releaseHeldList()
    releaseHeldList = null
  },
}

await i18n.changeLanguage('zh-CN')

export function AsyncQuestionBrowserPreview() {
  const initialTheme =
    new URLSearchParams(location.search).get('theme') === 'dark' ? 'dark' : 'light'
  const [selectedTask, setSelectedTask] = useState(task)
  const [theme, setTheme] = useState<'light' | 'dark'>(initialTheme)
  const [paneWidth, setPaneWidth] = useState(920)
  const [draft, setDraft] = useState('')
  const [ordinarySendCount, setOrdinarySendCount] = useState(0)
  const [changedEmitted, setChangedEmitted] = useState(false)
  const [goal, setGoal] = useState<RuntimeGoal>({
    threadId: task.threadId!, objective: '修复会话恢复并补充回归测试', mode: 'standard',
    status: 'active', tokenBudget: null, tokensUsed: 0, timeUsedSeconds: 138,
    createdAt: 1, updatedAt: 1,
  })
  const [queuedMessages, setQueuedMessages] = useState<QueuedWorkbenchMessage[]>([{
    id: 'e2e-status-queue', content: '修复后再检查深色主题', status: 'queued', createdAt: '2026-11-03T00:00:00Z',
  }])
  const [approvalPending, setApprovalPending] = useState(true)
  const [creationPending, setCreationPending] = useState(pendingCreationScene)
  const statusExtras = unifiedStatus && !['normal', 'questions', 'approval', 'creating', 'initial-error', 'list-error', 'unsupported'].includes(scene)
  const Region = unifiedStatus ? ComposerStatusRegion : Fragment

  useLayoutEffect(() => {
    applyAppearance({ ...defaultAppearance, mode: theme }, theme)
  }, [theme])

  return (
    <div
      className={`${longLayout ? 'flex h-dvh flex-col overflow-hidden' : 'min-h-screen'} min-w-0 bg-background text-text-primary`}
    >
      <header className="flex shrink-0 flex-wrap items-center gap-2 border-b border-border px-4 py-3">
        <strong>异步问题卡片浏览器验收</strong>
        <span data-testid="fixture-boundary" className="text-xs text-text-muted">
          受控 runtime fixture · 不连接 Gateway、Native 或模型
        </span>
        <div className={longLayout ? 'hidden' : 'ml-auto flex flex-wrap gap-2'}>
          {pendingCreationScene ? <Button data-testid="fixture-complete-creation" size="sm"
            onClick={() => setCreationPending(false)}>完成任务登记</Button> : null}
          {retryRace || answerRace ? [task, alternateTask].map((address, index) => (
            <Button key={address.taskId} size="sm" variant="outline"
              data-testid={`fixture-task-${index === 0 ? 'a' : 'b'}`}
              onClick={() => setSelectedTask(address)}>
              任务 {index === 0 ? 'A' : 'B'}
            </Button>
          )) : null}
          <Button
            size="sm"
            variant="outline"
            data-testid="fixture-theme-toggle"
            onClick={() => setTheme(value => (value === 'light' ? 'dark' : 'light'))}
          >
            切换主题
          </Button>
          <Button
            size="sm"
            variant={paneWidth === 920 ? 'secondary' : 'outline'}
            data-testid="fixture-pane-width-normal"
            aria-pressed={paneWidth === 920}
            onClick={() => setPaneWidth(920)}
          >
            正常宽度
          </Button>
          <Button
            size="sm"
            variant={paneWidth === 420 ? 'secondary' : 'outline'}
            data-testid="fixture-pane-width-narrow"
            aria-pressed={paneWidth === 420}
            onClick={() => setPaneWidth(420)}
          >
            窄分栏
          </Button>
          <Button
            size="sm"
            variant="outline"
            data-testid="fixture-emit-changed"
            disabled={changedEmitted}
            onClick={() => {
              setChangedEmitted(true)
              void emitChanged()
            }}
          >
            发送 changed 通知
          </Button>
        </div>
      </header>
      <main className={`${longLayout ? 'min-h-0 flex-1' : ''} min-w-0 p-4`}>
        <section
          data-testid="async-question-browser-pane"
          data-pane-width={paneWidth}
          className={`mx-auto flex min-w-0 flex-col ${longLayout ? 'h-full min-h-0 gap-2' : 'gap-3'}`}
          style={{ width: paneWidth, maxWidth: '100%' }}
        >
          <div className="rounded-lg border border-border bg-surface px-3 py-2 text-xs text-text-secondary">
            Fixture turn state: <span data-testid="fixture-turn-state">idle</span>
          </div>
          {longLayout ? (
            <div
              data-testid="fixture-transcript"
              className="min-h-12 flex-1 overflow-y-auto text-sm text-text-primary"
            >
              {Array.from({ length: 12 }, (_, index) => (
                <p key={index} className="py-2">
                  已有对话 {index + 1}：先继续不依赖答案的工作，问题不会挡住这段历史。
                </p>
              ))}
            </div>
          ) : null}
          <Region>
          <AsyncQuestionPanel key={answerRace ? selectedTask.taskId : undefined} address={selectedTask}
            pendingCreation={creationPending} />
          <div className="shrink-0">
            {unifiedStatus && scene === 'approval' && approvalPending ? (
              <RequestUserInputCard
                payload={{ requestId: 'e2e-approval', itemId: 'approval-e2e-command', questions: [{
                  id: 'approval-choice', header: '权限确认', question: '允许本次执行测试命令？',
                  options: [{ label: '仅允许本次', description: '只允许当前测试命令' }, { label: '拒绝', description: '不执行命令' }],
                }] }}
                autoSubmitOnOptionSelect={false}
                preselectFirstOption={false}
                focusOnMount={false}
                onSubmit={() => setApprovalPending(false)}
              />
            ) : (
            <BufferedChatInput
              value={draft}
              onChange={setDraft}
              onSubmit={async () => setOrdinarySendCount(value => value + 1)}
              disabled={false}
              variant="desktop"
              showProjectWorkBar={false}
              placeholder="普通对话仍可输入"
              error={unifiedStatus && scene === 'error' ? '消息未发送，草稿已保留。请检查连接后重试。' : undefined}
              goal={statusExtras ? goal : undefined}
              onPauseGoal={() => setGoal(current => ({ ...current, status: 'paused' }))}
              onResumeGoal={() => setGoal(current => ({ ...current, status: 'active' }))}
              onClearGoal={() => setGoal(current => ({ ...current, status: 'cancelled' }))}
              taskPlan={statusExtras ? { plan: [
                { step: '定位空面板出现的原因', status: 'completed' },
                { step: '修改显示条件', status: 'completed' },
                { step: '验证会话切换与草稿保留', status: 'inProgress' },
                { step: '检查明暗主题', status: 'pending' },
              ] } : undefined}
              queuedMessages={statusExtras ? queuedMessages : []}
              onEditQueuedMessage={id => {
                const queued = queuedMessages.find(message => message.id === id)
                if (queued) setDraft(queued.content)
                setQueuedMessages(current => current.filter(message => message.id !== id))
              }}
              onCancelQueuedMessage={id => setQueuedMessages(current => current.filter(message => message.id !== id))}
            />
            )}
          </div>
          </Region>
          <output className={longLayout ? 'sr-only' : ''} data-testid="fixture-ordinary-send-count">
            {ordinarySendCount}
          </output>
        </section>
      </main>
    </div>
  )
}

createRoot(document.getElementById('root')!).render(<AsyncQuestionBrowserPreview />)
