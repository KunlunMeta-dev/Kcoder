import { act, renderHook } from '@testing-library/react'
import { expect, test } from 'vitest'
import { notifyAccountContextChange } from './accountContextEvents'
import { useWorkspaceFileNavigation } from './useWorkspaceFileNavigation'
import type { WorkspaceFileCommentDraft } from '@/types/workspace-files'

const root = { deviceId: 'owner-device', path: '/workspace', source: 'runtime' as const }
const other = { deviceId: 'other-device', path: '/other', source: 'runtime' as const }

const commentDraft: WorkspaceFileCommentDraft = {
  filePath: '/workspace/result.txt', fileName: 'result.txt', revision: 'preview-v1', sourceRevision: 'artifact-v1',
  sourceContent: 'original result', targetKey: 'line:1', selectedText: 'original result', startLine: 1, endLine: 1,
  comment: 'Keep the original feedback',
}

test('closing files preserves the original unsent selection, text and versions', () => {
  const { result } = renderHook(() => useWorkspaceFileNavigation('comments-owner', root))
  act(() => expect(result.current.fileCommentController.setDraft(commentDraft)).toBe(true))
  act(() => result.current.setOpenFileRequest(null))
  expect(result.current.fileCommentController.draft).toEqual(commentDraft)
  expect(result.current.hasFileCommentDrafts).toBe(true)
})

test('file comment targets retain separate drafts and reject callbacks from a previously selected target', () => {
  const { result, rerender } = renderHook(({ target }) => useWorkspaceFileNavigation('comments-targets', target), { initialProps: { target: root } })
  act(() => result.current.fileCommentController.setDraft(commentDraft))
  const old = result.current.fileCommentController
  rerender({ target: other })
  expect(result.current.fileCommentController.draft).toBeNull()
  act(() => expect(old.setDraft({ ...commentDraft, comment: 'Late overwrite' })).toBe(false))
  act(() => result.current.fileCommentController.setDraft({ ...commentDraft, comment: 'Other target' }))
  rerender({ target: root })
  expect(result.current.fileCommentController.draft?.comment).toBe(commentDraft.comment)
  rerender({ target: other })
  expect(result.current.fileCommentController.draft?.comment).toBe('Other target')
})

test('an earlier comment revision cannot erase newer typing or a new task draft', () => {
  const { result, rerender } = renderHook(({ owner }) => useWorkspaceFileNavigation(owner, root), { initialProps: { owner: 'comments-A' } })
  act(() => result.current.fileCommentController.setDraft(commentDraft))
  const old = result.current.fileCommentController
  act(() => result.current.fileCommentController.setDraft({ ...commentDraft, comment: 'New typing' }))
  act(() => expect(old.setDraft(null)).toBe(false))
  expect(result.current.fileCommentController.draft?.comment).toBe('New typing')
  const oldTask = result.current.fileCommentController
  rerender({ owner: 'comments-B' })
  expect(result.current.fileCommentController.draft).toBeNull()
  act(() => expect(oldTask.setDraft(commentDraft)).toBe(false))
  rerender({ owner: 'comments-A' })
  expect(result.current.fileCommentController.draft?.comment).toBe('New typing')
  act(() => expect(oldTask.setDraft(null)).toBe(false))
  expect(result.current.fileCommentController.draft?.comment).toBe('New typing')
})

test('account changes invalidate file comments before rerender and remove only the affected cached target', () => {
  const { result, rerender } = renderHook(({ target }) => useWorkspaceFileNavigation('comments-accounts', target, root.deviceId), { initialProps: { target: other } })
  act(() => result.current.fileCommentController.setDraft(commentDraft))
  const old = result.current.fileCommentController
  rerender({ target: root })
  act(() => result.current.fileCommentController.setDraft({ ...commentDraft, comment: 'Owner feedback' }))
  act(() => {
    notifyAccountContextChange(other.deviceId)
    expect(old.isCurrent()).toBe(false)
    expect(old.setDraft(commentDraft)).toBe(false)
  })
  expect(result.current.fileCommentController.draft?.comment).toBe('Owner feedback')
  rerender({ target: other })
  expect(result.current.fileCommentController.draft).toBeNull()
  act(() => result.current.fileCommentController.setDraft(commentDraft))
  const ownerChanged = result.current.fileCommentController
  act(() => {
    notifyAccountContextChange(root.deviceId)
    expect(ownerChanged.isCurrent()).toBe(false)
  })
  expect(result.current.fileCommentController.draft).toBeNull()
  expect(result.current.hasFileCommentDrafts).toBe(false)
})

test('comment capacity never evicts old unsent feedback and can be released explicitly', () => {
  const { result, rerender } = renderHook(({ path }) => useWorkspaceFileNavigation('comments-capacity', { ...root, path }), { initialProps: { path: '/0' } })
  for (let index = 0; index < 32; index++) {
    rerender({ path: `/${index}` })
    act(() => expect(result.current.fileCommentController.setDraft({ ...commentDraft, comment: `Feedback ${index}` })).toBe(true))
  }
  rerender({ path: '/overflow' })
  act(() => expect(result.current.fileCommentController.setDraft(commentDraft)).toBe(false))
  expect(result.current.fileCommentController.capacityExceeded).toBe(true)
  expect(result.current.fileCommentController.draft).toBeNull()
  rerender({ path: '/0' })
  expect(result.current.fileCommentController.draft?.comment).toBe('Feedback 0')
  act(() => result.current.fileCommentController.setDraft(null))
  rerender({ path: '/overflow' })
  act(() => expect(result.current.fileCommentController.setDraft(commentDraft)).toBe(true))
  expect(result.current.fileCommentController.capacityExceeded).toBe(false)
})

test('unmounted file navigation cannot receive delayed feedback', () => {
  const { result, unmount } = renderHook(() => useWorkspaceFileNavigation('comments-unmount', root))
  const old = result.current.fileCommentController
  unmount()
  expect(old.setDraft(commentDraft)).toBe(false)
})

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
