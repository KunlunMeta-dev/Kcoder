import { act, renderHook } from '@testing-library/react'
import { afterEach, expect, test, vi } from 'vitest'
import type { WorkflowReference } from '@/features/workflows/workflowReferences'
import { useWorkflowCardsDismissal } from './useWorkflowCardsDismissal'

const first: WorkflowReference = { id: 'workflow-a', title: 'A', version: 1 }
const second: WorkflowReference = { id: 'workflow-b', title: 'B', version: 1 }

afterEach(() => {
  vi.restoreAllMocks()
  window.localStorage.clear()
})

test('dismissal survives remount in the same conversation and a new version reopens the cards', () => {
  const hook = renderHook(() => useWorkflowCardsDismissal('first-conversation', [first]))
  act(() => hook.result.current.dismiss())
  expect(hook.result.current.dismissed).toBe(true)
  hook.unmount()

  const reopened = renderHook(
    ({ scope, reference }) => useWorkflowCardsDismissal(scope, [reference]),
    { initialProps: { scope: 'first-conversation', reference: first } }
  )
  expect(reopened.result.current.dismissed).toBe(true)
  reopened.rerender({ scope: 'second-conversation', reference: first })
  expect(reopened.result.current.dismissed).toBe(false)
  reopened.rerender({ scope: 'first-conversation', reference: { ...first, version: 2 } })
  expect(reopened.result.current.dismissed).toBe(false)
})

test('unavailable storage preserves all dismissals made in the current view', () => {
  vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
    throw new Error('storage is unavailable')
  })
  const hook = renderHook(
    ({ references }) => useWorkflowCardsDismissal('storage-fallback', references),
    { initialProps: { references: [first] } }
  )
  act(() => hook.result.current.dismiss())
  hook.rerender({ references: [second] })
  expect(hook.result.current.dismissed).toBe(false)
  act(() => hook.result.current.dismiss())
  hook.rerender({ references: [first, second] })
  expect(hook.result.current.dismissed).toBe(true)
})
