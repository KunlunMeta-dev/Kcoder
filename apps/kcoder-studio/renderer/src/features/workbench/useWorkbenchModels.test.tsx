import { act, renderHook, waitFor } from '@testing-library/react'
import { expect, test, vi } from 'vitest'
import { useWorkbenchModels } from './useWorkbenchModels'
import type { UnifiedModelListResponse } from '@/types/api'

test('a late catalog response preserves the permission choice made while models were loading', async () => {
  let resolve!: (value: UnifiedModelListResponse) => void
  const pending = new Promise<UnifiedModelListResponse>(done => {
    resolve = done
  })
  const api = { listModels: vi.fn(() => pending) }
  const { result } = renderHook(() =>
    useWorkbenchModels({ api, locked: false, persistSelection: false, scopeKey: 'draft' })
  )
  act(() => result.current.setSelectedModelOption('kcoderPermissionMode', 'ask'))
  await act(async () => {
    resolve({ data: [{ name: 'gpt-5.5', type: 'public', modelId: 'gpt-5.5' }] })
    await pending
  })
  await waitFor(() => expect(result.current.isLoading).toBe(false))
  expect(result.current.error).toBeNull()
  expect(result.current.models).toHaveLength(1)
  expect(result.current.selectedModelOptions.kcoderPermissionMode).toBe('ask')
})
