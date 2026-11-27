import { describe, expect, test } from 'vitest'
import { agentInteractionSource } from './agentInteractionSource'

describe('typed runtime Agent question source', () => {
  test('legacy absent source remains an unassigned parent interaction', () => {
    expect(agentInteractionSource(undefined, 'parent')).toBeUndefined()
  })
  test.each(['', ' ', '\t\n', '\u3000'])(
    'rejects blank worker or background-run identity %j', identity => {
      expect(() => agentInteractionSource({ parentSessionId: 'parent', agentId: identity }, 'parent'))
        .toThrow('parent identity conflict')
      expect(() => agentInteractionSource({ parentSessionId: 'parent', agentId: 'actual',
        backgroundRun: { parentSessionId: 'parent', agentId: 'actual', runId: identity } }, 'parent'))
        .toThrow('run identity conflict')
    }
  )
  test('checks presence without rewriting opaque worker or run identities', () => {
    const source = { parentSessionId: 'parent', agentId: ' actual ',
      backgroundRun: { parentSessionId: 'parent', agentId: ' actual ', runId: ' run-1 ' } }
    expect(agentInteractionSource(source, 'parent')).toEqual(source)
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
