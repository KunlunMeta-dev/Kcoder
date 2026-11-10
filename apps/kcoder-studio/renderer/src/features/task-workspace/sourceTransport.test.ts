import { afterEach, expect, test, vi } from 'vitest'
const fixture = vi.hoisted(() => ({ request: vi.fn() }))
vi.mock('@/host/localExecutor', () => ({ requestLocalExecutor: fixture.request }))
vi.mock('@/kcoder/accountContextEvents', () => ({
  captureAccountContextRevision: () => () => true,
}))
import { createTaskWorkspaceTransport } from '@/kcoder/taskWorkspaceTransport'
import type {
  IntegrationRequest,
  IntegrationTaskCapabilityScopeControlTarget,
} from '../../../../shared/generated/contracts'
const scope = {
  accountId: 'owner',
  targetId: 'native',
  workspaceId: null,
  identityGeneration: '1',
  targetRevision: '1',
}
const target: IntegrationTaskCapabilityScopeControlTarget = {
  initialAttempt: { threadId: 'thread', turnId: 'turn', attemptId: 'attempt' },
  runtimeOperationId: 'runtime-op',
}
function snapshot(source?: IntegrationTaskCapabilityScopeControlTarget) {
  return {
    schemaVersion: 1,
    scope,
    snapshotId: 'snapshot',
    observedAtMs: 1,
    thread: {
      reference: { kind: 'thread', threadId: 'thread' },
      title: 'Original task',
      nativeStatus: 'idle',
      sourceMethod: 'thread/read',
      nativeRevision: null,
    },
    entries: [],
    facets: [],
    artifactRefs: [],
    runtime: null,
    sourceSelection: null,
    nextCursor: null,
    ...(source ? { sourceTarget: source } : {}),
  }
}
function reply(request: IntegrationRequest, result: unknown) {
  return {
    contractVersion: 'parallel-v1',
    requestId: request.requestId,
    operationId: null,
    entityRevision: null,
    status: 'completed',
    observedAt: '2026-10-25T00:00:00Z',
    result,
    error: null,
  }
}
afterEach(() => fixture.request.mockReset())
test('carries the explicit full tuple and accepts only the same source-target echo under the original owner', async () => {
  fixture.request.mockImplementation(async (_method, params) =>
    params.method === 'integrations/scope/read'
      ? scope
      : reply(params.params, snapshot(params.params.payload.sourceTarget))
  )
  const transport = createTaskWorkspaceTransport(
    { serverId: 'native', workspacePath: '/owned' },
    () => true
  )
  const result = await transport.read({ threadId: 'thread', sourceTarget: target })
  expect(result.sourceTarget).toEqual(target)
  expect(fixture.request).toHaveBeenLastCalledWith(
    'runtime.integrations.request',
    expect.objectContaining({
      serverId: 'native',
      workspacePath: '/owned',
      method: 'integrations/tasks/readWorkspace',
      params: expect.objectContaining({ payload: { threadId: 'thread', sourceTarget: target } }),
    }),
    { signal: expect.any(AbortSignal) }
  )
  transport.dispose()
})
test('rejects another original attempt or runtime operation rather than substituting a latest record', async () => {
  fixture.request.mockImplementation(async (_method, params) =>
    params.method === 'integrations/scope/read'
      ? scope
      : reply(
          params.params,
          snapshot({
            ...target,
            initialAttempt: { ...target.initialAttempt, attemptId: 'different' },
          })
        )
  )
  const transport = createTaskWorkspaceTransport({ serverId: 'native' }, () => true)
  await expect(transport.read({ threadId: 'thread', sourceTarget: target })).rejects.toMatchObject({
    code: 'invalid_reply',
  })
  transport.dispose()
})
test('freezes the caller selector before awaited scope lookup so mutation cannot change the observation fence', async () => {
  let release!: (value: unknown) => void
  fixture.request.mockImplementation((_method, params) =>
    params.method === 'integrations/scope/read'
      ? new Promise(resolve => {
          release = resolve
        })
      : Promise.resolve(reply(params.params, snapshot(params.params.payload.sourceTarget)))
  )
  const transport = createTaskWorkspaceTransport({ serverId: 'native' }, () => true)
  const mutable = { threadId: 'thread', sourceTarget: structuredClone(target) }
  const pending = transport.read(mutable)
  mutable.sourceTarget.initialAttempt.attemptId = 'changed-after-dispatch'
  release(scope)
  expect((await pending).sourceTarget).toEqual(target)
  transport.dispose()
})
