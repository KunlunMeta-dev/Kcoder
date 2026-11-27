import { act, renderHook } from '@testing-library/react'
import { afterEach, expect, test, vi } from 'vitest'
import { notifyAccountContextChange } from '@/kcoder/accountContextEvents'
import { useBranchMenuScope } from './useBranchMenuScope'

const target = { deviceId: 'scope-branch-owner', path: '/owned/scope' }
afterEach(() => vi.unstubAllGlobals())

test('a target/workspace lifetime cannot revive after A to B to A', () => {
  const hook = renderHook(({ current }) => useBranchMenuScope(current), {
    initialProps: { current: target },
  })
  const old = hook.result.current
  hook.rerender({ current: { ...target, path: '/replacement' } })
  expect(old.isCurrent()).toBe(false)
  hook.rerender({ current: { ...target } })
  expect(old.isCurrent()).toBe(false)
  expect(hook.result.current.isCurrent()).toBe(true)
  const last = hook.result.current
  hook.unmount()
  expect(last.isCurrent()).toBe(false)
})

test.each(['account', 'configuration'] as const)(
  '%s invalidation retires old callbacks immediately without a directory or authentication request',
  kind => {
    const fetcher = vi.fn()
    vi.stubGlobal('fetch', fetcher)
    const hook = renderHook(() => useBranchMenuScope(target))
    const old = hook.result.current
    act(() => {
      if (kind === 'account') notifyAccountContextChange(target.deviceId)
      else
        window.dispatchEvent(
          new CustomEvent('kcoder:servers-changed', { detail: { targetId: target.deviceId } })
        )
      expect(old.isCurrent()).toBe(false)
    })
    expect(old.isCurrent()).toBe(false)
    expect(hook.result.current.isCurrent()).toBe(true)
    expect(fetcher).not.toHaveBeenCalled()
  }
)
