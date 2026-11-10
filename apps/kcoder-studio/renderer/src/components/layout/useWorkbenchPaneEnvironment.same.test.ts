import { describe, expect, test } from 'vitest'
import { sameEnvironmentInfo } from './useWorkbenchPaneEnvironment'

describe('polled environment snapshots', () => {
  const base = {
    additions: '3',
    deletions: '1',
    executionTarget: 'local' as const,
    branchName: 'main',
    workspaceRoots: ['/a', '/b'],
    loading: false,
  }

  test('an unchanged poll result keeps the previous snapshot', () => {
    expect(sameEnvironmentInfo(base, { ...base, workspaceRoots: ['/a', '/b'] })).toBe(true)
  })

  test('any changed, added or removed value is a new snapshot', () => {
    expect(sameEnvironmentInfo(base, { ...base, additions: '4' })).toBe(false)
    expect(sameEnvironmentInfo(base, { ...base, workspaceRoots: ['/a'] })).toBe(false)
    expect(sameEnvironmentInfo(base, { ...base, error: 'offline' })).toBe(false)
    expect(sameEnvironmentInfo(base, { ...base, branchName: undefined })).toBe(false)
  })
})
