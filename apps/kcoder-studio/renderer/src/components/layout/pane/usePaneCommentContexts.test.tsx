import { act, renderHook } from '@testing-library/react'
import { expect, test } from 'vitest'
import { notifyAccountContextChange } from '@/kcoder/accountContextEvents'
import type { CodeCommentContext } from '@/types/workspace-files'
import { restoreSubmittedComments, retireSubmittedComments, usePaneCommentContexts } from './usePaneCommentContexts'

const comment: CodeCommentContext = { id: 'original', filePath: '/workspace/result.txt', fileName: 'result.txt',
  startLine: 1, endLine: 1, selectedText: 'original bytes', fileRevision: 'native-v1', comment: 'Revise this', createdAt: '2026-10-26' }

test('blank feedback is isolated by destination and remains available when returning to that destination', () => {
  const { result, rerender } = renderHook(({ scope, device }) => usePaneCommentContexts(scope, device), { initialProps: { scope: 'blank:/A', device: 'feedback-A' } })
  act(() => result.current.setCodeCommentContexts([comment]))
  const old = result.current.setCodeCommentContexts
  rerender({ scope: 'blank:/B', device: 'feedback-B' })
  expect(result.current.codeCommentContexts).toEqual([])
  expect(result.current.hasCodeCommentDrafts).toBe(true)
  act(() => old([{ ...comment, comment: 'Late overwrite' }]))
  rerender({ scope: 'blank:/A', device: 'feedback-A' })
  expect(result.current.codeCommentContexts).toEqual([comment])
  act(() => old([{ ...comment, comment: 'Late after returning' }]))
  expect(result.current.codeCommentContexts).toEqual([comment])
})

test('account invalidation clears only its destinations and rejects old failure restoration before repaint', () => {
  const { result, rerender } = renderHook(({ device }) => usePaneCommentContexts('blank-feedback', device), { initialProps: { device: 'feedback-account-A' } })
  act(() => result.current.setCodeCommentContexts([comment]))
  const old = result.current.setCodeCommentContexts
  rerender({ device: 'feedback-account-B' })
  act(() => result.current.setCodeCommentContexts([{ ...comment, id: 'other-account' }]))
  act(() => {
    notifyAccountContextChange('feedback-account-A')
    old([comment])
  })
  expect(result.current.codeCommentContexts.map(row => row.id)).toEqual(['other-account'])
  rerender({ device: 'feedback-account-A' })
  expect(result.current.codeCommentContexts).toEqual([])
  act(() => old([comment]))
  expect(result.current.codeCommentContexts).toEqual([])
})

test('unbound destination feedback is removed on an account change and cannot be restored by an old callback', () => {
  const { result } = renderHook(() => usePaneCommentContexts('blank-unbound'))
  act(() => result.current.setCodeCommentContexts([comment]))
  const old = result.current.setCodeCommentContexts
  act(() => { notifyAccountContextChange('feedback-unbound-device'); old([comment]) })
  expect(result.current.codeCommentContexts).toEqual([])
})

test('a completed or failed send preserves feedback added or edited while it was pending', () => {
  const edited = { ...comment, comment: 'Newer user correction' }
  const added = { ...comment, id: 'added-after-send' }
  expect(retireSubmittedComments([comment, added], [comment])).toEqual([added])
  expect(retireSubmittedComments([edited, added], [comment])).toEqual([edited, added])
  expect(restoreSubmittedComments([edited, added], [comment])).toEqual([edited, added])
  expect(restoreSubmittedComments([added], [comment])).toEqual([comment, added])
})

test('disposing a pane prevents a later send callback from restoring feedback', () => {
  const { result, unmount } = renderHook(() => usePaneCommentContexts('disposed-feedback', 'feedback-disposed-device'))
  const old = result.current.setCodeCommentContexts
  unmount()
  let applied = false
  act(() => old(() => { applied = true; return [comment] }))
  expect(applied).toBe(false)
})
