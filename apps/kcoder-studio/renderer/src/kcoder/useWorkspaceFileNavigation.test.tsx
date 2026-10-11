import { act, renderHook } from '@testing-library/react'
import { expect, test } from 'vitest'
import { notifyAccountContextChange } from './accountContextEvents'
import { useWorkspaceFileNavigation } from './useWorkspaceFileNavigation'

const root = { deviceId: 'owner-device', path: '/workspace', source: 'runtime' as const }
const other = { deviceId: 'other-device', path: '/other', source: 'runtime' as const }

test('a proposed target remains pending until its current request commits', () => {
  const { result } = renderHook(() => useWorkspaceFileNavigation('task-A', root))
  const token = result.current.beginFileOpenRequest()
  const request = {
    id: token.id,
    path: '/other/b.ts',
    target: other,
    isCurrent: () => token.isCurrent(other.deviceId),
  }
  act(() => result.current.setOpenFileRequest(request))
  expect(result.current.committedFileWorkspaceTarget).toBeNull()
  act(() => expect(result.current.commitFileOpenRequest(request)).toBe(true))
  expect(result.current.committedFileWorkspaceTarget).toEqual(other)
})

test('a newer intent or closing Files invalidates a pending directory lookup', () => {
  const { result } = renderHook(() => useWorkspaceFileNavigation('task-A', root))
  const old = result.current.beginFileOpenRequest()
  const current = result.current.beginFileOpenRequest()
  expect(old.isCurrent(root.deviceId)).toBe(false)
  act(() => result.current.setOpenFileRequest(null))
  expect(current.isCurrent(root.deviceId)).toBe(false)
})

test('changing owner clears accepted targets and rejects old setters, tokens and commits', () => {
  const { result, rerender } = renderHook(({ owner }) => useWorkspaceFileNavigation(owner, root), {
    initialProps: { owner: 'task-A' },
  })
  const oldSetter = result.current.setOpenFileRequest
  const oldCommit = result.current.commitFileOpenRequest
  const token = result.current.beginFileOpenRequest()
  const request = {
    id: token.id,
    path: '/other/b.ts',
    target: other,
    isCurrent: () => token.isCurrent(other.deviceId),
  }
  act(() => result.current.setOpenFileRequest(request))
  act(() => result.current.commitFileOpenRequest(request))
  rerender({ owner: 'task-B' })
  act(() => {
    oldSetter(request)
    expect(oldCommit(request)).toBe(false)
  })
  expect(result.current.openFileRequest).toBeNull()
  expect(result.current.committedFileWorkspaceTarget).toBeNull()
  expect(token.isCurrent(other.deviceId)).toBe(false)
  rerender({ owner: 'task-A' })
  expect(token.isCurrent(other.deviceId)).toBe(false)
})

test('account invalidation clears the active target without reviving the old file request', () => {
  const { result } = renderHook(() => useWorkspaceFileNavigation('task-A', root))
  const token = result.current.beginFileOpenRequest()
  const request = {
    id: token.id,
    path: '/workspace/a.ts',
    target: root,
    isCurrent: () => token.isCurrent(root.deviceId),
  }
  act(() => result.current.setOpenFileRequest(request))
  act(() => result.current.commitFileOpenRequest(request))
  const scope = result.current.fileNavigationScope
  act(() => notifyAccountContextChange(root.deviceId))
  expect(result.current.fileNavigationScope).not.toBe(scope)
  expect(result.current.openFileRequest).toBeNull()
  expect(result.current.committedFileWorkspaceTarget).toBeNull()
  expect(token.isCurrent(root.deviceId)).toBe(false)
})

test('invalidation of a proposed target preserves the accepted target of another account', () => {
  const { result } = renderHook(() => useWorkspaceFileNavigation('task-A', root))
  const first = result.current.beginFileOpenRequest()
  const accepted = {
    id: first.id,
    path: '/workspace/a.ts',
    target: root,
    isCurrent: () => first.isCurrent(root.deviceId),
  }
  act(() => result.current.setOpenFileRequest(accepted))
  act(() => result.current.commitFileOpenRequest(accepted))
  const next = result.current.beginFileOpenRequest()
  const proposed = {
    id: next.id,
    path: '/other/b.ts',
    target: other,
    isCurrent: () => next.isCurrent(other.deviceId),
  }
  act(() => result.current.setOpenFileRequest(proposed))
  act(() => notifyAccountContextChange(other.deviceId))
  expect(result.current.committedFileWorkspaceTarget).toEqual(root)
  expect(result.current.openFileRequest).toBeNull()
  expect(next.isCurrent(other.deviceId)).toBe(false)
})

test('cancelling a proposal preserves the accepted target and invalidates its pending callbacks', () => {
  const { result } = renderHook(() => useWorkspaceFileNavigation('task-A', root))
  const first = result.current.beginFileOpenRequest()
  const accepted = {
    id: first.id,
    path: '/other/a.ts',
    target: other,
    isCurrent: () => first.isCurrent(other.deviceId),
  }
  act(() => result.current.setOpenFileRequest(accepted))
  act(() => result.current.commitFileOpenRequest(accepted))
  const next = result.current.beginFileOpenRequest()
  const proposed = {
    id: next.id,
    path: '/workspace/b.ts',
    target: root,
    isCurrent: () => next.isCurrent(root.deviceId),
  }
  act(() => result.current.setOpenFileRequest(proposed))
  act(() => result.current.cancelFileOpenRequest(proposed))
  expect(result.current.committedFileWorkspaceTarget).toEqual(other)
  expect(result.current.openFileRequest).toBeNull()
  expect(next.isCurrent(root.deviceId)).toBe(false)
  expect(result.current.commitFileOpenRequest(proposed)).toBe(false)
})
