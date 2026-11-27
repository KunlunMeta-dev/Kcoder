import { afterEach, expect, test, vi } from 'vitest'
import { createTaskCapabilityScopeDirectoryTransport } from '@/kcoder/taskCapabilityScopeDirectoryTransport'
import { notifyAccountContextChange } from '@/kcoder/accountContextEvents'
import { installTaskWorkspaceGateway, nativeScope, reply } from './gatewayFixture.test-support'
import type { IntegrationTaskCapabilityScopeDirectorySnapshot } from '../../../../shared/generated/contracts'

const method = 'integrations/tasks/readSavedTaskSourceBindings'
const target = { serverId: 'local', workspacePath: '/owned-workspace' }
const owned: { dispose(): Promise<void> }[] = []
afterEach(async () => {
  await Promise.all(owned.splice(0).map(item => item.dispose()))
  vi.restoreAllMocks()
  localStorage.clear()
})
function page(): IntegrationTaskCapabilityScopeDirectorySnapshot {
  return {
    entries: [
      {
        referenceId: 'original-binding',
        target: {
          initialAttempt: {
            threadId: 'original-thread',
            turnId: 'original-turn',
            attemptId: 'original-attempt',
          },
          runtimeOperationId: null,
        },
        savedSnapshot: {
          threadId: 'original-thread',
          revision: 2,
          selection: { mode: 'none', sources: [] },
          effectiveSources: [],
          effectiveFrom: 'current_snapshot',
        },
        observationState: 'saved_only',
        reasonCode: null,
      },
    ],
    observationState: 'saved_only',
    nextCursor: null,
    reasonCode: null,
  }
}

test('real LocalExecutor/Gateway forwards only the negotiated saved directory and keeps original lookup identities', async () => {
  const gateway = installTaskWorkspaceGateway(
    async (name, params) =>
      name === 'integrations/scope/read' ? nativeScope : reply(params, page()),
    [method]
  )
  owned.push(gateway)
  const transport = createTaskCapabilityScopeDirectoryTransport(target, () => true)
  const observed = await transport.read({ threadId: 'original-thread' })
  expect(observed.entries[0].target?.initialAttempt.attemptId).toBe('original-attempt')
  expect(gateway.calls.map(call => call.method)).toEqual(['integrations/scope/read', method])
  expect(gateway.calls[1].params).toMatchObject({
    scope: nativeScope,
    payload: { threadId: 'original-thread' },
  })
  expect(Object.hasOwn(gateway.calls[1].params, 'operationId')).toBe(false)
  transport.dispose()
})

test('directory support does not imply live control and missing directory capability never requests data', async () => {
  const gateway = installTaskWorkspaceGateway(undefined, [method])
  owned.push(gateway)
  gateway.supported.mockImplementation(capability => capability !== 'taskSourceDirectoryV1')
  const transport = createTaskCapabilityScopeDirectoryTransport(target, () => true)
  await expect(transport.read({})).rejects.toThrow('INTEGRATION_TARGET_UPGRADE_REQUIRED')
  expect(gateway.calls.map(call => call.method)).toEqual(['integrations/scope/read'])
  transport.dispose()
})

test.each(['foreign-thread', 'duplicate', 'too-many', 'live-ready'])(
  'rejects %s data instead of promoting saved records into current authority',
  async bad => {
    const gateway = installTaskWorkspaceGateway(
      async (name, params) => {
        if (name === 'integrations/scope/read') return nativeScope
        const value = page()
        if (bad === 'foreign-thread')
          value.entries[0].target!.initialAttempt.threadId = 'peer-thread'
        if (bad === 'duplicate') value.entries.push(structuredClone(value.entries[0]))
        if (bad === 'too-many')
          value.entries = Array.from({ length: 11 }, (_, index) => ({
            ...value.entries[0],
            referenceId: `record-${index}`,
          }))
        if (bad === 'live-ready')
          (value as unknown as { observationState: string }).observationState = 'ready'
        return reply(params, value)
      },
      [method]
    )
    owned.push(gateway)
    const transport = createTaskCapabilityScopeDirectoryTransport(target, () => true)
    await expect(transport.read({ threadId: 'original-thread' })).rejects.toThrow(
      'TASK_CAPABILITY_SCOPE_DIRECTORY_INVALID_REPLY'
    )
    transport.dispose()
  }
)

test('a changed actual account cannot publish a delayed original directory response', async () => {
  const gateway = installTaskWorkspaceGateway(
    async (name, params) => {
      if (name === 'integrations/scope/read') return nativeScope
      notifyAccountContextChange('local')
      return reply(params, page())
    },
    [method]
  )
  owned.push(gateway)
  const transport = createTaskCapabilityScopeDirectoryTransport(target, () => true)
  await expect(transport.read({})).rejects.toThrow()
  transport.dispose()
})
