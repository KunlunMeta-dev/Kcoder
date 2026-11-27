import { afterEach, expect, test, vi } from 'vitest'
vi.mock('@/kcoder/accountContextEvents', () => ({
  captureAccountContextRevision: () => () => true,
}))
import { requestNativeIntegration } from '@/kcoder/gatewayIntegrations'
import type { GatewayRuntimeCore } from '@/kcoder/gateway/runtime/core'
const scope = {
  accountId: 'native-owner',
  targetId: 'native-target',
  workspaceId: null,
  identityGeneration: '1',
  targetRevision: '1',
}
const selected = {
  initialAttempt: {
    threadId: 'original-thread',
    turnId: 'original-turn',
    attemptId: 'original-attempt',
  },
  runtimeOperationId: 'original-runtime',
}
const request = {
  contractVersion: 'parallel-v1',
  requestId: 'task-workspace-source-capability',
  scope,
  timeoutMs: 1000,
  payload: { threadId: 'original-thread' },
}
afterEach(() => vi.restoreAllMocks())
function runtime(scopeSupport: boolean) {
  const client = {
    supportsExperimental: (cap: string) =>
      cap === 'taskWorkspaceSourcesV1' ? scopeSupport : true,
    request: vi.fn(async () => ({
      contractVersion: 'parallel-v1',
      requestId: request.requestId,
      operationId: null,
      entityRevision: null,
      status: 'completed',
      observedAt: '2026-10-25T00:00:00Z',
      result: {},
      error: null,
    })),
  }
  const target = { id: 'selected-native', transport: 'local', workspacePath: '/owned' }
  const core = {
    disposed: false,
    configurationEpochByTarget: new Map(),
    assertCommandTarget: vi.fn(async (selected: typeof target) => { expect(selected).toBe(target) }),
    serverForParams: vi.fn(async () => target),
    commandClient: vi.fn(async () => client),
  } as unknown as GatewayRuntimeCore
  return { core, client }
}
test('task capability scope-enriched workspace requires the actual additional target handshake, not a payload permission flag', async () => {
  const fixture = runtime(false)
  await expect(
    requestNativeIntegration.call(fixture.core, {
      serverId: 'selected-native',
      workspacePath: '/owned',
      method: 'integrations/tasks/readWorkspace',
      params: { ...request, payload: { ...request.payload, sourceTarget: selected } },
    })
  ).rejects.toMatchObject({ code: 'INTEGRATION_TARGET_UPGRADE_REQUIRED' })
  expect(fixture.client.request).not.toHaveBeenCalled()
})
test('legacy task reads keep their old capability and supported task capability scope reads preserve the exact tuple', async () => {
  const old = runtime(false)
  await requestNativeIntegration.call(old.core, {
    serverId: 'selected-native',
    method: 'integrations/tasks/readWorkspace',
    params: request,
  })
  expect(old.client.request).toHaveBeenCalledTimes(1)
  const current = runtime(true)
  const fields = { ...request, payload: { ...request.payload, sourceTarget: selected } }
  await requestNativeIntegration.call(current.core, {
    serverId: 'selected-native',
    method: 'integrations/tasks/readWorkspace',
    params: fields,
  })
  expect(current.client.request).toHaveBeenCalledWith(
    'integrations/tasks/readWorkspace',
    fields,
    undefined
  )
})
