import { describe, expect, test } from 'vitest'
import { agentInteractionSource } from './agentInteractionSource'

describe('typed runtime Agent question source', () => {
  test('legacy absent source remains an unassigned parent interaction', () => {
    expect(agentInteractionSource(undefined, 'parent')).toBeUndefined()
  })
  test('validates actual parent and background run identities', () => {
    expect(
      agentInteractionSource(
        {
          parentSessionId: 'parent',
          agentId: 'actual',
          backgroundRun: { parentSessionId: 'parent', agentId: 'actual', runId: 'run-1' },
        },
        'parent'
      )
    ).toEqual({
      parentSessionId: 'parent',
      agentId: 'actual',
      backgroundRun: { parentSessionId: 'parent', agentId: 'actual', runId: 'run-1' },
    })
    expect(() =>
      agentInteractionSource({ parentSessionId: 'other', agentId: 'actual' }, 'parent')
    ).toThrow('parent identity conflict')
    expect(() =>
      agentInteractionSource(
        {
          parentSessionId: 'parent',
          agentId: 'actual',
          backgroundRun: { parentSessionId: 'parent', agentId: 'forged', runId: 'run-1' },
        },
        'parent'
      )
    ).toThrow('run identity conflict')
  })
})
