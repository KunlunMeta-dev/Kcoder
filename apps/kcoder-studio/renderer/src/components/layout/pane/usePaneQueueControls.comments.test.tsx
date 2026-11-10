import { act, renderHook } from '@testing-library/react'
import { expect, test, vi } from 'vitest'
import { notifyAccountContextChange } from '@/kcoder/accountContextEvents'
import type { CodeCommentContext } from '@/types/workspace-files'
import { usePaneQueueControls } from './usePaneQueueControls'

const original = { deviceId: 'comment-queue-owner', taskId: 'original-task' }
const comment: CodeCommentContext = {
  id: 'comment', filePath: '/workspace/result.txt', fileName: 'result.txt', startLine: 1, endLine: 1,
  selectedText: 'original', fileRevision: 'native-v1', comment: 'Revise this', createdAt: '2026-10-26',
}

function setup() {
  let comments: CodeCommentContext[] = []
  const context = {
    currentRuntimeTask: original,
    currentRuntimeTaskRef: { current: original },
    accountScopeInvalidatedRef: { current: false },
    setCodeCommentContexts: vi.fn((update: (rows: CodeCommentContext[]) => CodeCommentContext[]) => { comments = update(comments) }),
  }
  const hook = renderHook(() => usePaneQueueControls(context as unknown as Parameters<typeof usePaneQueueControls>[0]))
  return { ...hook, context, comments: () => comments }
}

test('adding feedback retains its actual file version in the original pane draft', () => {
  const value = setup()
  act(() => value.result.current.addCodeComment(comment))
  expect(value.comments()).toEqual([comment])
})

test('a stale pane callback cannot add source feedback to a replacement task', () => {
  const value = setup()
  const old = value.result.current.addCodeComment
  value.context.currentRuntimeTaskRef.current = { ...original, taskId: 'replacement-task' }
  act(() => old(comment))
  expect(value.context.setCodeCommentContexts).not.toHaveBeenCalled()
})

test('account changes reject feedback immediately, before the pane cleanup rerenders', () => {
  const value = setup()
  act(() => {
    notifyAccountContextChange(original.deviceId)
    value.result.current.addCodeComment(comment)
  })
  expect(value.comments()).toEqual([])
})

test('an invalidated pane cannot regain comment authority by creating another callback', () => {
  const value = setup()
  value.context.accountScopeInvalidatedRef.current = true
  value.rerender()
  act(() => value.result.current.addCodeComment(comment))
  expect(value.comments()).toEqual([])
})
