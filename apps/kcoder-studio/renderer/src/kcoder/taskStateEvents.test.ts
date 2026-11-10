import { expect, test, vi } from 'vitest'
import { TaskStateEventConsumer } from './taskStateEvents'
import type { IntegrationScope, IntegrationTaskStateObservation } from '../../../shared/generated/contracts.integrations-core'

const scope: IntegrationScope = { accountId: 'owner', targetId: 'target', workspaceId: 'workspace', identityGeneration: '1', targetRevision: '1' }
const observation = (revision: number, extra: Partial<IntegrationTaskStateObservation> = {}): IntegrationTaskStateObservation => ({
  scope, operationId: 'original', entityId: 'original', sequence: revision, revision,
  observedAtMs: 1234, snapshot: false, reference: { threadId: 'thread', turnId: 'turn' }, state: 'running', ...extra,
})

test('a late first event reads only its exact original snapshot and never replays a task', async () => {
  const read = vi.fn(async (method: string) => method === 'integrations/scope/read' ? scope : observation(8, { snapshot: true }))
  const consumer = new TaskStateEventConsumer(read as never, () => true)
  expect((await consumer.accept(observation(7)))?.revision).toBe(8)
  expect(read.mock.calls.map(call => call[0])).toEqual(['integrations/scope/read', 'integrations/runtime/readTaskState'])
  expect(await consumer.accept(observation(8))).toBeNull()
  consumer.dispose()
})

test('a changed account during native scope read publishes nothing', async () => {
  let finish!: (scope: IntegrationScope) => void
  let current = true
  const read = vi.fn(() => new Promise<IntegrationScope>(resolve => { finish = resolve }))
  const consumer = new TaskStateEventConsumer(read as never, () => current)
  const pending = consumer.accept(observation(1))
  current = false
  finish(scope)
  expect(await pending).toBeNull()
  expect(read).toHaveBeenCalledTimes(1)
})

test('a snapshot from a different Accepted reference is rejected', async () => {
  const read = vi.fn(async (method: string) => method === 'integrations/scope/read' ? scope
    : observation(7, { snapshot: true, reference: { threadId: 'thread', turnId: 'another' } }))
  const consumer = new TaskStateEventConsumer(read as never, () => true)
  expect(await consumer.accept(observation(7))).toBeNull()
  consumer.dispose()
})

test('a later running snapshot cannot roll a completed entity back', async () => {
  const read = vi.fn(async () => scope)
  const consumer = new TaskStateEventConsumer(read as never, () => true)
  expect((await consumer.accept(observation(1, { state: 'completed' })))?.state).toBe('completed')
  expect(await consumer.accept(observation(9, { snapshot: true }))).toBeNull()
  expect(read).toHaveBeenCalledTimes(1)
  consumer.dispose()
})
