import { expect, test } from 'vitest'
import type { RuntimeSubagentStatus } from '@/types/workbench'
import { mergeSubagentSteeringState as merge } from './subagentSteerState'

const base: RuntimeSubagentStatus = { id: 'a', agentId: 'a', agentPath: 'a', agentName: 'worker', status: 'running' }
const event = (steerStatus: string, steerMessageId: string) => ({ agentPath: 'a', steerStatus, steerMessageId })

test('a late queued snapshot cannot regress an applied message', () => {
  const applied = { ...base, ...merge(base, event('applied', 'one')) }
  expect(merge(applied, { ...event('queued_live', 'one'), occurredAtMs: Date.now() + 10000 })).toMatchObject({ steerStatus: 'applied', steerMessageId: 'one' })
  expect(merge(applied, { agentPath: 'a', status: 'running' })).toMatchObject({ steerStatus: 'applied' })
})

test('a new instruction may queue and an older completion does not replace it', () => {
  const first = { ...base, ...merge(base, event('queued_live', 'one')) }
  const second = { ...base, ...merge(first, event('queued_live', 'two')) }
  const oldDone = { ...base, ...merge(second, event('applied', 'one')) }
  expect(oldDone).toMatchObject({ steerStatus: 'queued_live', steerMessageId: 'two' })
  expect(merge(oldDone, event('queued_live', 'one'))).toMatchObject({ steerMessageId: 'two' })
  expect(merge(oldDone, event('applied', 'two'))).toMatchObject({ steerStatus: 'applied', steerMessageId: 'two' })
  const latest = { ...base, ...merge(oldDone, event('applied', 'two')) }
  expect(merge(latest, event('applied', 'one'))).toMatchObject({ steerMessageId: 'two' })
})

test('completed identity memory is bounded per agent', () => {
  let current = base
  for (let i = 0; i < 100; i++) current = { ...base, ...merge(current, event('applied', String(i))) }
  expect(current.appliedSteerMessageIds).toHaveLength(32)
  expect(current.appliedSteerMessageIds?.at(-1)).toBe('99')
  expect(current.observedSteerMessageIds).toHaveLength(32)
})

test('an unseen completion replaces an earlier queue before its acknowledgement arrives', () => {
  const first = { ...base, ...merge(base, event('queued_live', 'one')) }
  const completed = { ...base, ...merge(first, event('applied', 'two')) }
  expect(completed).toMatchObject({ steerStatus: 'applied', steerMessageId: 'two' })
  expect(merge(completed, event('queued_live', 'two'))).toMatchObject({ steerStatus: 'applied', steerMessageId: 'two' })
  expect(merge(completed, event('queued_live', 'one'))).toMatchObject({ steerStatus: 'applied', steerMessageId: 'two' })
})

test('a late queued snapshot of an observed older instruction does not replace the current queue', () => {
  const first = { ...base, ...merge(base, event('queued_live', 'one')) }
  const second = { ...base, ...merge(first, event('queued_live', 'two')) }
  expect(merge(second, event('queued_live', 'one'))).toMatchObject({ steerStatus: 'queued_live', steerMessageId: 'two' })
})
