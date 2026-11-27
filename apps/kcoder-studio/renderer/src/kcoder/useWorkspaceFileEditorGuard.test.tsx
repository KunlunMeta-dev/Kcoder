import { act, renderHook } from '@testing-library/react'
import { expect, test, vi } from 'vitest'
import { useWorkspaceFileNavigation } from './useWorkspaceFileNavigation'
import { notifyAccountContextChange } from './accountContextEvents'

const target = { deviceId: 'editor-device', path: '/workspace', source: 'runtime' as const }
test('the same mounted editor may settle a submitted save without clearing another registration', () => {
  const { result } = renderHook(() => useWorkspaceFileNavigation('owner-A', target))
  const owner = {}
  let complete!: () => void
  let releaseOld!: () => void
  act(() => {
    releaseOld = result.current.fileEditorNavigation.register({
      owner,
      dirty: true,
      navigate: action => {
        complete = action
      },
    })
  })
  expect(result.current.fileEditorNavigation.dirty).toBe(true)
  const close = vi.fn()
  act(() => result.current.fileEditorNavigation.request(close))
  expect(close).not.toHaveBeenCalled()
  act(() =>
    result.current.fileEditorNavigation.register({
      owner,
      dirty: false,
      navigate: action => action(),
    })
  )
  act(() => releaseOld())
  act(() => complete())
  expect(close).toHaveBeenCalledTimes(1)
  expect(result.current.fileEditorNavigation.dirty).toBe(false)
})

test('old save callbacks and old cleanup cannot close a newer owner, including A to B to A', () => {
  const { result, rerender } = renderHook(
    ({ scope }) => useWorkspaceFileNavigation(scope, target),
    { initialProps: { scope: 'A' } }
  )
  let complete!: () => void
  let release!: () => void
  const oldNavigation = result.current.fileEditorNavigation
  act(() => {
    release = oldNavigation.register({
      owner: {},
      dirty: true,
      navigate: action => {
        complete = action
      },
    })
  })
  const close = vi.fn()
  act(() => oldNavigation.request(close))
  rerender({ scope: 'B' })
  rerender({ scope: 'A' })
  act(() =>
    result.current.fileEditorNavigation.register({ owner: {}, dirty: true, navigate: () => {} })
  )
  act(() => {
    release()
    complete()
    oldNavigation.request(close)
  })
  expect(close).not.toHaveBeenCalled()
  expect(result.current.fileEditorNavigation.dirty).toBe(true)
})

test('an editor account change or an unmounted owner invalidates pending parent navigation', () => {
  const { result, unmount } = renderHook(() => useWorkspaceFileNavigation('owner', target))
  let complete!: () => void
  const close = vi.fn()
  act(() =>
    result.current.fileEditorNavigation.register({
      owner: {},
      deviceId: 'file-device',
      dirty: true,
      navigate: action => {
        complete = action
      },
    })
  )
  act(() => result.current.fileEditorNavigation.request(close))
  act(() => notifyAccountContextChange('file-device'))
  act(() => complete())
  expect(close).not.toHaveBeenCalled()
  const navigation = result.current.fileEditorNavigation
  unmount()
  navigation.request(close)
  expect(close).not.toHaveBeenCalled()
})
