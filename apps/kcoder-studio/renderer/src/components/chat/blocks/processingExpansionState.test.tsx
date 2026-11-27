import { act, cleanup, renderHook } from '@testing-library/react'
import { afterEach, expect, test } from 'vitest'
import {
  clearPersistentProcessingExpansions,
  usePersistentProcessingExpansion,
  useProcessingExpansionSnapshot,
} from './processingExpansionState'

afterEach(() => { cleanup(); clearPersistentProcessingExpansions() })

test.each([{ keys: [] }, { keys: ['selected'] }])('unrelated folds do not redraw a snapshot of $keys', ({ keys }) => {
  let renders = 0
  const reader = renderHook(() => { renders++; return useProcessingExpansionSnapshot(keys) })
  const writer = renderHook(() => usePersistentProcessingExpansion('other'))
  const before = reader.result.current, count = renders
  act(() => writer.result.current[1](true))
  expect(reader.result.current).toBe(before)
  expect(renders).toBe(count)
})

test('selected folds update, retain explicit false and reread immediately when keys change', () => {
  const writer = renderHook(() => usePersistentProcessingExpansion('selected'))
  const other = renderHook(() => usePersistentProcessingExpansion('other'))
  const reader = renderHook(({ keys }) => useProcessingExpansionSnapshot(keys), {
    initialProps: { keys: ['selected'] },
  })
  expect(reader.result.current.has('selected')).toBe(false)
  act(() => writer.result.current[1](true))
  expect(reader.result.current.get('selected')).toBe(true)
  act(() => writer.result.current[1](false))
  expect(reader.result.current.get('selected')).toBe(false)
  act(() => other.result.current[1](true))
  expect(reader.result.current.has('other')).toBe(false)
  reader.rerender({ keys: ['other'] })
  expect([...reader.result.current]).toEqual([['other', true]])
  reader.rerender({ keys: ['selected'] })
  expect([...reader.result.current]).toEqual([['selected', false]])
  act(() => clearPersistentProcessingExpansions())
  expect(reader.result.current.size).toBe(0)
})
