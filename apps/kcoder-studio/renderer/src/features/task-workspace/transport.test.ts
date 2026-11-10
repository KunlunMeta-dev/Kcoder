import { afterEach, expect, test, vi } from 'vitest'
import { createTaskWorkspaceTransport } from '@/kcoder/taskWorkspaceTransport'
import { notifyAccountContextChange } from '@/kcoder/accountContextEvents'
import {
  installTaskWorkspaceGateway,
  nativeScope,
  reply,
  snapshot,
  taskMethod,
} from './gatewayFixture.test-support'

const owned: { dispose(): Promise<void> }[] = []
afterEach(async () => {
  await Promise.all(owned.splice(0).map(item => item.dispose()))
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
  localStorage.clear()
})
const target = { serverId: 'local', workspacePath: '/owned-workspace' }

test('actual LocalExecutor and Gateway forward only the finite read, original target, scope and signal', async () => {
  const gateway = installTaskWorkspaceGateway()
  owned.push(gateway)
  const transport = createTaskWorkspaceTransport(target, () => true)
  const result = await transport.read({ threadId: 'original-thread' })
  expect(result.thread.reference).toEqual({ kind: 'thread', threadId: 'original-thread' })
  expect(result.facets[1].observedCount).toBeNull()
  expect(gateway.calls.map(call => call.method)).toEqual(['integrations/scope/read', taskMethod])
  const request = gateway.calls[1]
  expect(request.params).toMatchObject({
    scope: nativeScope,
    payload: { threadId: 'original-thread' },
    timeoutMs: 15000,
  })
  expect(Object.hasOwn(request.params, 'operationId')).toBe(false)
  expect(request.signal).toBeInstanceOf(AbortSignal)
  expect(
    gateway.client.requests.some(call =>
      ['thread/start', 'thread/resume', 'turn/start'].includes(call.method)
    )
  ).toBe(false)
  transport.dispose()
})

test('negotiated task capability is required before native task data is requested', async () => {
  const gateway = installTaskWorkspaceGateway()
  owned.push(gateway)
  gateway.supported.mockImplementation(name => name !== 'taskWorkspaceV1')
  const transport = createTaskWorkspaceTransport(target, () => true)
  await expect(transport.read({ threadId: 'original-thread' })).rejects.toMatchObject({
    code: 'unsupported',
  })
  expect(gateway.calls.map(call => call.method)).toEqual(['integrations/scope/read'])
  transport.dispose()
})

test.each(['foreign_thread', 'foreign_scope', 'oversized', 'wrong_snapshot', 'accepted'])(
  'rejects %s instead of treating it as a matching observation',
  async kind => {
    const gateway = installTaskWorkspaceGateway(async (method, params) => {
      if (method === 'integrations/scope/read') return nativeScope
      const value = snapshot()
      if (kind === 'foreign_thread') value.entries[0].reference.threadId = 'another-thread'
      if (kind === 'foreign_scope') value.scope = { ...nativeScope, accountId: 'another-account' }
      if (kind === 'oversized') value.entries = Array.from({ length: 11 }, () => value.entries[0])
      const response = reply(params, value)
      if (kind === 'accepted') {
        response.status = 'accepted'
        response.operationId = 'not-a-read-completion'
      }
      return response
    })
    owned.push(gateway)
    const transport = createTaskWorkspaceTransport(target, () => true)
    await expect(
      transport.read(
        { threadId: 'original-thread', cursor: 'original-cursor' },
        { snapshotId: kind === 'wrong_snapshot' ? 'another-snapshot' : 'original-observation' }
      )
    ).rejects.toMatchObject({
      code: kind === 'wrong_snapshot' ? 'cursor_invalid' : 'invalid_reply',
    })
    transport.dispose()
  }
)

test('native cursor expiry is distinguishable and never executes or resumes a task', async () => {
  const gateway = installTaskWorkspaceGateway(async (method, params) =>
    method === 'integrations/scope/read'
      ? nativeScope
      : {
          ...reply(params),
          status: 'rejected',
          result: null,
          error: {
            code: 'TASK_WORKSPACE_CURSOR_EXPIRED',
            recovery: 'retry_read',
            messageKey: 'integration.unavailable',
          },
        }
  )
  owned.push(gateway)
  const transport = createTaskWorkspaceTransport(target, () => true)
  await expect(
    transport.read({ threadId: 'original-thread', cursor: 'opaque-old-cursor' })
  ).rejects.toMatchObject({ code: 'cursor_invalid' })
  expect(gateway.calls.filter(call => call.method === taskMethod)).toHaveLength(1)
  transport.dispose()
})

test('account invalidation and a late native reply cannot populate a new owner or replay', async () => {
  let resolve!: (value: unknown) => void
  let begun!: () => void
  const started = new Promise<void>(done => {
    begun = done
  })
  const gateway = installTaskWorkspaceGateway(async (method, params) => {
    if (method === 'integrations/scope/read') return nativeScope
    begun()
    return new Promise(done => {
      resolve = value => done(value ?? reply(params))
    })
  })
  owned.push(gateway)
  const transport = createTaskWorkspaceTransport(target, () => true)
  const pending = transport.read({ threadId: 'original-thread' })
  const rejected = expect(pending).rejects.toMatchObject({ code: 'scope_changed' })
  await started
  notifyAccountContextChange('local')
  resolve(null)
  await rejected
  expect(gateway.calls.filter(call => call.method === taskMethod)).toHaveLength(1)
  transport.dispose()
})

test('caller cancellation reaches actual IPC waiters and consumes a late native result', async () => {
  let complete!: () => void
  const gateway = installTaskWorkspaceGateway(async (method, params) => {
    if (method === 'integrations/scope/read') return nativeScope
    return new Promise(done => {
      complete = () => done(reply(params))
    })
  })
  owned.push(gateway)
  const transport = createTaskWorkspaceTransport(target, () => true)
  const controller = new AbortController()
  const pending = transport.read({ threadId: 'original-thread' }, { signal: controller.signal })
  const rejected = expect(pending).rejects.toMatchObject({ code: 'cancelled' })
  await vi.waitFor(() => expect(gateway.calls.some(call => call.method === taskMethod)).toBe(true))
  controller.abort()
  await rejected
  expect(gateway.calls.find(call => call.method === taskMethod)?.signal?.aborted).toBe(true)
  complete()
  transport.dispose()
})

test('LAN HTTP without randomUUID still correlates the native read using the existing request ID helper', async () => {
  const gateway = installTaskWorkspaceGateway()
  owned.push(gateway)
  const actual = globalThis.crypto
  vi.stubGlobal('crypto', { getRandomValues: actual.getRandomValues.bind(actual) })
  const transport = createTaskWorkspaceTransport(target, () => true)
  await transport.read({ threadId: 'original-thread' })
  expect(gateway.calls.find(call => call.method === taskMethod)?.params.requestId).toMatch(
    /^[a-f0-9-]{36}$/
  )
  transport.dispose()
})
