import { expect, test } from 'vitest'
import type { RuntimeSubagentStatus } from '@/types/workbench'
import { markRuntimeSubagentsSettled } from './subagentSteerState'

test('parent completion does not finish an independently running background agent', () => {
  const background: RuntimeSubagentStatus = {
    id: 'job-a', agentId: 'job-a', agentPath: 'job-a', agentName: 'worker',
    status: 'running', kind: 'background', steerStatus: 'queued_live',
  }
  const foreground = { ...background, id: 'foreground', kind: 'tool' }
  const result = markRuntimeSubagentsSettled([background, foreground])
  expect(result[0]).toBe(background)
  expect(result[1].status).toBe('done')
})
