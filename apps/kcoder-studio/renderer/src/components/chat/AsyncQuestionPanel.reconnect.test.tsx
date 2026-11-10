import { act, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeAll, beforeEach, expect, it, vi } from 'vitest'
import { createInstance } from 'i18next'
import { initReactI18next } from 'react-i18next'
import type { AsyncQuestionRecord } from '../../../../shared/generated/contracts'
import chat from '@/i18n/locales/en/chat.json'
import common from '@/i18n/locales/en/common.json'
import type { GatewayRuntimeCore } from '@/kcoder/gateway/runtime/core'
import type { GatewayTask } from '@/kcoder/gateway/runtime/contracts'
import { recoverTaskAfterDisconnect } from '@/kcoder/gateway/runtime/recovery'
import type { LocalExecutorEvent } from '@/host/localExecutor'
import { AsyncQuestionPanel } from './AsyncQuestionPanel'

const bridge = vi.hoisted(() => ({ request: vi.fn(), listeners: new Set<(event: LocalExecutorEvent) => void>(), emitted: [] as LocalExecutorEvent[] }))
vi.mock('@/host/localExecutor', () => ({
  requestLocalExecutor: bridge.request,
  subscribeLocalExecutorEvents: async (listener: (event: LocalExecutorEvent) => void) => {
    bridge.listeners.add(listener)
    return () => { bridge.listeners.delete(listener) }
  },
}))
vi.mock('@/kcoder/gatewayServiceBridge', () => ({
  emitRuntimeEvent: async (_name: string, event: LocalExecutorEvent) => {
    bridge.emitted.push(event)
    for (const listener of bridge.listeners) listener(event)
  },
}))

const address = { taskId: 'recovered-task', deviceId: 'server', threadId: 'thread', workspacePath: '/workspace' }
const pending: AsyncQuestionRecord = {
  questionId: 'question', requestId: 'request', threadId: address.threadId,
  sourceTurnId: 'source', toolCallId: 'tool', revision: 1, createdAtMs: 1,
  status: 'pending', questions: [{ id: 'item', header: 'Mode', question: 'Which mode?',
    multiSelect: false, options: [{ id: 'fast', label: 'Fast', description: '' }] }],
}
const answered: AsyncQuestionRecord = { ...pending, revision: 2, status: 'context_applied',
  answer: { submissionId: 'other-device', acceptedAtMs: 2, answers: { item: { selectedOptionIds: ['fast'] } } } }

beforeAll(async () => {
  await createInstance().use(initReactI18next).init({
    lng: 'en', resources: { en: { chat, common } }, interpolation: { escapeValue: false },
  })
})
beforeEach(() => { bridge.request.mockReset(); bridge.listeners.clear(); bridge.emitted.length = 0 })

function recover(options: { supported?: boolean; replaced?: boolean } = {}) {
  const task = { ...address, serverId: address.deviceId } as GatewayTask
  const client = { supportsExperimental: () => options.supported !== false }
  const clientByTask = new Map()
  let job!: Promise<unknown>
  const runtime = {
    disposed: false, tasks: new Map([[task.taskId, task]]), clientByTask,
    disconnectRecoveryByTask: new Map(), appServerDisconnectedClients: new WeakSet(),
    isRestartingServer: () => false,
    resumeTask: async () => { clientByTask.set(task.taskId, options.replaced ? {} : client); return client },
    trackAsyncJob: (value: Promise<unknown>) => { job = value },
  } as unknown as GatewayRuntimeCore
  recoverTaskAfterDisconnect.call(runtime, task, Promise.resolve())
  return job
}

it.each(['pending', 'empty', 'support-error', 'list-error'] as const)(
  'recovery reconciles %s cards with changes made by another device without replaying an answer', async initial => {
    let recovered = false
    bridge.request.mockImplementation(async (command, params) => {
      if (command === 'runtime.asyncQuestion.supports') {
        if (!recovered && initial === 'support-error') throw new Error('connection unavailable')
        return { supported: true, threadId: address.threadId }
      }
      if (params.method !== 'asyncQuestion/list') throw new Error('A recovery must only read questions')
      if (!recovered && initial === 'list-error') throw new Error('list unavailable')
      return { threadId: address.threadId, questions: recovered ? [answered] : initial === 'empty' ? [] : [pending] }
    })
    render(<AsyncQuestionPanel address={address} />)
    await waitFor(() => expect(bridge.request.mock.calls.length).toBe(initial === 'support-error' ? 1 : 2))
    await act(async () => {})
    const before = bridge.request.mock.calls.length
    recovered = true
    await act(async () => { await recover() })
    expect(bridge.request.mock.calls.length).toBeGreaterThan(before)
    await waitFor(() => expect(screen.getByTestId('async-question-card-question')).toHaveAttribute('data-status', 'context_applied'))
    expect(bridge.request.mock.calls.every(([, params]) => !params.method || params.method === 'asyncQuestion/list')).toBe(true)
  }
)

it('a recovery list preserves the existing answer draft while it is pending or fails', async () => {
  let recovered = false
  let reject!: (error: Error) => void
  bridge.request.mockImplementation(async (command, params) => {
    if (command === 'runtime.asyncQuestion.supports') return { supported: true, threadId: address.threadId }
    if (params.method !== 'asyncQuestion/list') throw new Error('Unexpected mutation')
    if (recovered) return new Promise((_resolve, fail) => { reject = fail })
    return { threadId: address.threadId, questions: [pending] }
  })
  render(<AsyncQuestionPanel address={address} />)
  await userEvent.click(await screen.findByTestId('async-question-toggle'))
  const draft = screen.getByTestId('request-user-input-custom-item')
  await userEvent.type(draft, 'Keep my unfinished answer')
  recovered = true
  await act(async () => { await recover() })
  expect(draft).toHaveValue('Keep my unfinished answer')
  expect(reject).toBeTypeOf('function')
  await act(async () => { reject(new Error('recovery list unavailable')) })
  expect(draft).toHaveValue('Keep my unfinished answer')
  expect(screen.getByTestId('async-question-retry')).toBeEnabled()
})

it('does not signal a superseded recovery', async () => {
  await recover({ replaced: true })
  expect(bridge.emitted.filter(event => event.event === 'async-question:refresh')).toEqual([])
})

it('an unresolved task retries capability discovery after its original connection recovers', async () => {
  let recovered = false
  bridge.request.mockImplementation(async (command, params) => {
    if (command === 'runtime.asyncQuestion.supports') {
      if (!recovered) throw new Error('connection unavailable')
      return { supported: true, threadId: address.threadId }
    }
    if (params.method !== 'asyncQuestion/list') throw new Error('Unexpected mutation')
    return { threadId: address.threadId, questions: [pending] }
  })
  render(<AsyncQuestionPanel address={{ ...address, threadId: undefined }} />)
  await screen.findByTestId('async-question-retry')
  recovered = true
  await act(async () => { await recover() })
  await screen.findByTestId('async-question-card-question')
})

it.each(['taskId', 'serverId', 'threadId', 'workspacePath'])(
  'a recovery from another %s cannot refresh the displayed task', async field => {
    bridge.request.mockImplementation(async (command) => command === 'runtime.asyncQuestion.supports'
      ? { supported: true, threadId: address.threadId }
      : { threadId: address.threadId, questions: [pending] })
    render(<AsyncQuestionPanel address={address} />)
    await screen.findByTestId('async-question-card-question')
    const before = bridge.request.mock.calls.length
    await act(async () => {
      for (const listener of bridge.listeners) listener({ event: 'async-question:refresh', payload: {
        taskId: address.taskId, serverId: address.deviceId, threadId: address.threadId,
        workspacePath: address.workspacePath, [field]: 'another-owner',
      } })
    })
    expect(bridge.request.mock.calls).toHaveLength(before)
    expect(screen.getByTestId('async-question-card-question')).toHaveAttribute('data-status', 'pending')
  }
)

it.each([false, true])('an old capability read cannot override recovered questions (old read fails=%s)', async fails => {
  let finishOld!: () => void
  let first = true
  bridge.request.mockImplementation(async (command, params) => {
    if (command === 'runtime.asyncQuestion.supports') {
      if (first) {
        first = false
        return new Promise((resolve, reject) => { finishOld = () => fails
          ? reject(new Error('old disconnected capability read'))
          : resolve({ supported: false }) })
      }
      return { supported: true, threadId: address.threadId }
    }
    if (params.method !== 'asyncQuestion/list') throw new Error('Unexpected mutation')
    return { threadId: address.threadId, questions: [answered] }
  })
  render(<AsyncQuestionPanel address={address} />)
  await waitFor(() => expect(finishOld).toBeTypeOf('function'))
  await act(async () => { await recover() })
  await screen.findByTestId('async-question-card-question')
  await act(async () => { finishOld() })
  expect(screen.getByTestId('async-question-card-question')).toHaveAttribute('data-status', 'context_applied')
  expect(screen.queryByTestId('async-question-retry')).not.toBeInTheDocument()
})

it('recovery to an unsupported connection retires old cards without reading questions or sending input', async () => {
  let recovered = false
  bridge.request.mockImplementation(async (command, params) => {
    if (command === 'runtime.asyncQuestion.supports')
      return { supported: !recovered, threadId: address.threadId }
    expect(params.method).toBe('asyncQuestion/list')
    if (recovered) throw new Error('Asynchronous questions are not negotiated on this connection')
    return { threadId: address.threadId, questions: [pending] }
  })
  render(<AsyncQuestionPanel address={address} />)
  await screen.findByTestId('async-question-card-question')
  const before = bridge.request.mock.calls.length
  recovered = true
  await act(async () => { await recover({ supported: false }) })
  await waitFor(() => expect(screen.queryByTestId('async-question-panel')).not.toBeInTheDocument())
  expect(bridge.request.mock.calls.slice(before).map(([command]) => command))
    .toEqual(['runtime.asyncQuestion.supports'])
})
