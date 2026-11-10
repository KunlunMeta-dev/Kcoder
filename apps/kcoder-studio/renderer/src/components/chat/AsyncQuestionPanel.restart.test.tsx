import { act, render, screen, waitFor } from '@testing-library/react'
import { beforeAll, beforeEach, expect, it, vi } from 'vitest'
import userEvent from '@testing-library/user-event'
import { createInstance } from 'i18next'
import { initReactI18next } from 'react-i18next'
import type { AsyncQuestionRecord } from '../../../../shared/generated/contracts'
import chat from '@/i18n/locales/en/chat.json'
import common from '@/i18n/locales/en/common.json'
import type { GatewayRuntimeCore } from '@/kcoder/gateway/runtime/core'
import type { GatewayTask } from '@/kcoder/gateway/runtime/contracts'
import { restartAppServers } from '@/kcoder/gateway/runtime/lifecycle'
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

const address = { taskId: 'original-task', deviceId: 'server', threadId: 'thread', workspacePath: '/workspace' }
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

function fixture() {
  const task = { ...address, serverId: address.deviceId } as GatewayTask
  const server = { id: address.deviceId }
  let stopped = false
  let afterInitialize = () => {}
  const requests: string[] = []
  const client = {
    request: async (method: string) => {
      requests.push(method)
      if (method !== 'gateway/app-server/restart') throw new Error('Unexpected upstream mutation')
      stopped = true
      return { stopped: true, reconnectRequired: true }
    },
  }
  const probe = {}
  const runtime = {
    disposed: false, restartingAppServers: false, restartingServerId: null,
    activeTurnByTask: new Map(), backgroundJobById: new Map(),
    tasks: new Map([[task.taskId, task]]), clientByTask: new Map([[task.taskId, client]]),
    connectionsByClient: new Map([[client, { client, server, serverId: server.id,
      workspacePath: task.workspacePath, channel: 'runtime', ready: Promise.resolve() }]]),
    releaseClient: (value: unknown) => {
      if (value !== client) return
      runtime.connectionsByClient.delete(client)
      runtime.clientByTask.delete(task.taskId)
    },
    connectClient: async () => { afterInitialize(); return probe },
  } as unknown as GatewayRuntimeCore
  return { runtime, requests, stopped: () => stopped,
    afterInitialize: (callback: () => void) => { afterInitialize = callback },
    restart: () => restartAppServers.call(runtime, { serverId: server.id, ifIdle: true }),
  }
}

it.each(['answered', 'stale', 'initial-read-error'] as const)(
  'an acknowledged restart refreshes %s cards after the restart barrier without resending input', async initial => {
    const f = fixture()
    const restored = initial === 'stale' ? { ...pending, revision: 2, status: 'stale' as const } : answered
    bridge.request.mockImplementation(async (command, params) => {
      if (command === 'runtime.asyncQuestion.supports') return { supported: true, threadId: address.threadId }
      expect(params.method).toBe('asyncQuestion/list')
      expect(f.runtime.restartingAppServers).toBe(false)
      if (!f.stopped() && initial === 'initial-read-error') throw new Error('list unavailable')
      return { threadId: address.threadId, questions: [f.stopped() ? restored : pending] }
    })
    render(<AsyncQuestionPanel address={address} />)
    if (initial === 'initial-read-error') await screen.findByTestId('async-question-retry')
    else await screen.findByTestId('async-question-card-question')
    await act(async () => { await f.restart() })
    await waitFor(() => expect(screen.getByTestId('async-question-card-question')).toHaveAttribute('data-status', restored.status))
    expect(f.requests).toEqual(['gateway/app-server/restart'])
    expect(bridge.emitted).toEqual([{ event: 'async-question:refresh', payload: {
      taskId: address.taskId, serverId: address.deviceId, threadId: address.threadId, workspacePath: address.workspacePath,
    } }])
  }
)

it.each(['removed', 'rebound', 'disposed'] as const)('restart does not refresh a %s task binding', async change => {
  const f = fixture()
  f.afterInitialize(() => {
    if (change === 'removed') f.runtime.tasks.delete(address.taskId)
    else if (change === 'disposed') f.runtime.disposed = true
    else f.runtime.tasks.set(address.taskId, { ...f.runtime.tasks.get(address.taskId)!, workspacePath: '/other-workspace' })
  })
  await f.restart()
  expect(bridge.emitted).toEqual([])
})

it('restart does not refresh tasks on an unaffected target', async () => {
  const f = fixture()
  const peer = { ...f.runtime.tasks.get(address.taskId)!, taskId: 'peer', serverId: 'other-server' }
  f.runtime.tasks.set(peer.taskId, peer)
  f.runtime.clientByTask.set(peer.taskId, {} as never)
  await f.restart()
  expect(bridge.emitted.map(event => event.payload.taskId)).toEqual([address.taskId])
})

it('a failed initialize does not signal successful question recovery', async () => {
  const f = fixture()
  f.afterInitialize(() => { throw new Error('initialize failed') })
  await expect(f.restart()).rejects.toThrow('initialize failed')
  expect(f.runtime.restartingAppServers).toBe(false)
  expect(bridge.emitted).toEqual([])
})

it('a restart refused before stopping leaves question cards untouched', async () => {
  const f = fixture()
  f.runtime.activeTurnByTask.set(address.taskId, {} as never)
  await expect(f.restart()).resolves.toMatchObject({ restarted: false, requiresConfirmation: true })
  expect(f.requests).toEqual([])
  expect(bridge.emitted).toEqual([])
})

it.each(['unsupported', 'read-error', 'supported'] as const)(
  'restart rechecks the initialized target capability (%s) without losing a supported draft', async capability => {
    const f = fixture()
    let recovering = false
    bridge.request.mockImplementation(async (command, params) => {
      if (command === 'runtime.asyncQuestion.supports') {
        if (f.stopped() && !recovering) {
          if (capability === 'unsupported') return { supported: false, threadId: address.threadId }
          if (capability === 'read-error') throw new Error('new capability read unavailable')
        }
        return { supported: true, threadId: address.threadId }
      }
      expect(params.method).toBe('asyncQuestion/list')
      if (f.stopped() && capability !== 'supported' && !recovering)
        throw new Error('This connection has not negotiated asynchronous questions')
      return { threadId: address.threadId, questions: [pending] }
    })
    render(<AsyncQuestionPanel address={address} />)
    await userEvent.click(await screen.findByTestId('async-question-toggle'))
    const draft = screen.getByTestId('request-user-input-custom-item')
    await userEvent.type(draft, 'Keep this answer after restart')
    const listReads = () => bridge.request.mock.calls.filter(([, params]) =>
      params.method === 'asyncQuestion/list').length
    const before = listReads()
    await act(async () => { await f.restart() })
    await waitFor(() => expect(bridge.request.mock.calls.filter(([command]) =>
      command === 'runtime.asyncQuestion.supports')).toHaveLength(2))
    if (capability === 'unsupported') {
      await waitFor(() => expect(screen.queryByTestId('async-question-panel')).not.toBeInTheDocument())
      expect(listReads()).toBe(before)
      // A delayed change from the old stream cannot reuse the retired capability.
      await act(async () => {
        for (const listener of bridge.listeners) listener({ event: 'async-question:changed', payload: {
          taskId: address.taskId, serverId: address.deviceId, threadId: address.threadId,
          questionId: pending.questionId, revision: 2,
        } })
      })
      expect(listReads()).toBe(before)
    } else {
      if (capability === 'read-error') {
        expect(listReads()).toBe(before)
        expect(screen.getByTestId('async-question-retry')).toBeEnabled()
        recovering = true
        await userEvent.click(screen.getByTestId('async-question-retry'))
        await waitFor(() => expect(screen.queryByTestId('async-question-retry')).not.toBeInTheDocument())
      }
      expect(screen.getByTestId('request-user-input-custom-item')).toBe(draft)
      expect(draft).toHaveValue('Keep this answer after restart')
      expect(listReads()).toBe(before + 1)
    }
    expect(bridge.request.mock.calls.every(([, params]) =>
      !params.method || params.method === 'asyncQuestion/list')).toBe(true)
  }
)
