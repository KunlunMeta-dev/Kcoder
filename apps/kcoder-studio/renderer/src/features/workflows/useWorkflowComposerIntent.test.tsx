import { act, renderHook } from '@testing-library/react'
import { expect, test } from 'vitest'
import { useWorkflowComposerIntent } from './useWorkflowComposerIntent'
import { notifyAccountContextChange } from '@/kcoder/accountContextEvents'
test('workflow intent and existing draft survive project changes until a task is actually created', () => {
  const { result, rerender } = renderHook(
    ({ taskId }: { taskId?: string; project?: string }) => useWorkflowComposerIntent(taskId),
    {
      initialProps: { taskId: undefined, project: 'first' } as {
        taskId?: string
        project?: string
      },
    }
  )
  act(() => result.current.onChange({ active: true, definitionId: 'existing' }))
  rerender({ project: 'second' })
  expect(result.current).toMatchObject({ active: true, definitionId: 'existing' })
  rerender({ project: 'second', taskId: 'created-task' })
  expect(result.current.active).toBe(false)
  rerender({ project: 'third' })
  expect(result.current.active).toBe(false)
})
test('account switches clear pending workflow binding', () => {
  const { result } = renderHook(() => useWorkflowComposerIntent())
  act(() => result.current.onChange({ active: true, definitionId: 'private-draft' }))
  act(() => notifyAccountContextChange('target'))
  expect(result.current.active).toBe(false)
  expect(result.current.definitionId).toBeUndefined()
})
