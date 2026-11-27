import { expect, test, vi } from 'vitest'
import { initialWorkbenchState } from '@/features/workbench/workbenchReducer'
import { getWorkbenchDebugSnapshot, updateWorkbenchDebugSnapshot } from './debugPanel'

test('workbench readers evaluate only on demand and only release their own registration', () => {
  const input = (error: string) => ({
    state: { ...initialWorkbenchState, error },
    lifecycle: { version: 0, tasks: new Map(), runningTaskKeys: new Set<string>(), unreadTaskKeys: new Set<string>() },
    cloudWorkStatus: { availability: 'available' as const,
      checks: { teams: 'available' as const, devices: 'available' as const, runtimeWork: 'available' as const },
      error: null, updatedAt: null },
  })
  const original = vi.fn(() => input('original'))
  const releaseOriginal = updateWorkbenchDebugSnapshot(original)
  const current = vi.fn(() => input('current'))
  const releaseCurrent = updateWorkbenchDebugSnapshot(current)
  try {
    expect(original).not.toHaveBeenCalled()
    expect(current).not.toHaveBeenCalled()
    releaseOriginal()
    expect(getWorkbenchDebugSnapshot().workbench?.error).toBe('current')
    expect(original).not.toHaveBeenCalled()
    expect(current).toHaveBeenCalledTimes(1)
    getWorkbenchDebugSnapshot()
    expect(current).toHaveBeenCalledTimes(2)
    releaseCurrent()
    expect(getWorkbenchDebugSnapshot().workbench).toBeNull()
    expect(current).toHaveBeenCalledTimes(2)
  } finally { releaseOriginal(); releaseCurrent() }
})
