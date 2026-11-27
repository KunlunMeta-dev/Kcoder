import { expect, it } from 'vitest'
import type { ProcessingBlock, ToolBlock } from '@/types/workbench'
import { processActivityTiming } from './processActivityTiming'

const start = Date.parse('2026-11-22T10:00:00Z')
const tool = (id: string, offset: number, end?: number): ToolBlock => ({
  id, type: 'tool', toolName: 'read', createdAt: start + offset,
  status: end === undefined ? 'pending' : 'done',
  ...(end !== undefined && { completedAt: start + end }),
})

it('uses the first start and last receipt for overlapping parallel tools, not their summed duration', () => {
  expect(processActivityTiming([tool('earlier', 0, 9000), tool('later', 2000, 5000)], false))
    .toEqual({ running: false, startedAt: start, completedAt: start + 9000 })
})

it('keeps the group running until every parallel tool has its own terminal receipt', () => {
  expect(processActivityTiming([tool('earlier', 0), tool('later', 2000, 5000)], false))
    .toMatchObject({ running: true, completedAt: undefined })
})

it.each(['done', 'error', 'unknown'] as const)('does not manufacture time for a %s receipt without an end timestamp', status => {
  expect(processActivityTiming([{ ...tool('missing', 0), status }, tool('known', 2000, 5000)], false))
    .toMatchObject({ running: false, completedAt: undefined })
})

it('freezes an unknown tool at its recorded interruption boundary', () => {
  expect(processActivityTiming([{ ...tool('interrupted', 2000, 5000), status: 'unknown', rawStatus: 'result_unrecorded' }],
    false)).toMatchObject({ running: false, completedAt: start + 5000 })
})

it('stops a stale reasoning spinner after a model transition without inventing an end timestamp or closing tools', () => {
  const thought: ProcessingBlock = { id: 'thought', type: 'thinking', status: 'streaming', content: 'Think', createdAt: start }
  expect(processActivityTiming([thought], false))
    .toMatchObject({ running: false, completedAt: undefined })
  expect(processActivityTiming([thought, tool('running', 2000)], false))
    .toMatchObject({ running: true, completedAt: undefined })
  expect(processActivityTiming([thought], true).running).toBe(true)
})

it('rejects invalid or reversed timestamps instead of inventing zero or turn-wide durations', () => {
  expect(processActivityTiming([{ ...tool('invalid-start', 0, 3000), createdAt: NaN }], false).startedAt).toBeUndefined()
  expect(processActivityTiming([tool('reverse', 3000, 1000)], false).completedAt).toBeUndefined()
  expect(processActivityTiming([{ ...tool('invalid-end', 0, 3000), completedAt: Infinity }], false).completedAt).toBeUndefined()
  expect(processActivityTiming([], false)).toMatchObject({ startedAt: undefined, completedAt: undefined })
})
