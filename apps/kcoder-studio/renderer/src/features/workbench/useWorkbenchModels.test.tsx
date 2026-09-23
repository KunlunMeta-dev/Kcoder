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


test('catalog refresh ignores an older response after a newer refresh completes', async () => {
  const resolves: Array<(value: UnifiedModelListResponse) => void> = []
  const api = { listModels: vi.fn(() => new Promise<UnifiedModelListResponse>(resolve => resolves.push(resolve))) }
  const { result } = renderHook(() => useWorkbenchModels({ api, locked: false, persistSelection: false, scopeKey: 'race' }))
  await waitFor(() => expect(resolves).toHaveLength(1))
  act(() => window.dispatchEvent(new CustomEvent('wework:local-model-settings-changed')))
  await waitFor(() => expect(resolves).toHaveLength(2))
  await act(async () => resolves[1]({ data: [{ name: 'gpt-5.5-new', type: 'public', modelId: 'gpt-5.5' }] }))
  await act(async () => resolves[0]({ data: [{ name: 'gpt-5.5-old', type: 'public', modelId: 'gpt-5.5' }] }))
  expect(result.current.models[0].name).toBe('gpt-5.5-new')
  expect(result.current.isLoading).toBe(false)
})

test('an unavailable explicit model must not silently become the target default', async () => {
  const api = { listModels: vi.fn(async () => ({
    data: [{ name: 'gpt-5.5-default', type: 'public' as const, modelId: 'gpt-5.5' }],
  })) }
  const { result } = renderHook(() => useWorkbenchModels({
    api,
    locked: false,
    selectionConfig: { modelName: 'gpt-5.5-removed', modelType: 'public', options: {} },
    defaultSelectionConfig: () => ({ modelName: 'gpt-5.5-default', modelType: 'public', options: {} }),
  }))
  await waitFor(() => expect(result.current.isLoading).toBe(false))
  expect(result.current.models).toHaveLength(1)
  expect(result.current.selectedModel).toBeNull()
  expect(result.current.getSelectedModel()).toBeNull()
  expect(result.current.displaySelectedModel).toMatchObject({
    name: 'gpt-5.5-removed', compatibilityDisabled: true, compatibilityDisabledReason: 'unavailable',
  })
  expect(result.current.models.some(model => model.name === 'gpt-5.5-removed')).toBe(false)
})

test('missing explicit selection stays blocked when changing options and can be explicitly replaced', async () => {
  const model = { name: 'gpt-5.5-default', type: 'public' as const, modelId: 'gpt-5.5' }
  const api = { listModels: vi.fn(async () => ({ data: [model] })) }
  const onSelectionChange = vi.fn()
  const { result } = renderHook(() => useWorkbenchModels({ api, locked: false, onSelectionChange,
    selectionConfig: { modelName: 'gpt-5.5-removed', modelType: 'public', options: {} } }))
  await waitFor(() => expect(result.current.isLoading).toBe(false))
  expect(result.current.isSelectedModelUnavailable()).toBe(true)
  act(() => result.current.setSelectedModelOption('kcoderPermissionMode', 'ask'))
  expect(onSelectionChange).toHaveBeenLastCalledWith(expect.objectContaining({ modelName: 'gpt-5.5-removed' }))
  act(() => result.current.setSelectedModel(model))
  expect(result.current.isSelectedModelUnavailable()).toBe(false)
  expect(result.current.getSelectedModel()?.name).toBe(model.name)
})

test('explicitly following default persists an empty model selection', async () => {
  const model = { name: 'gpt-5.5', type: 'public' as const, modelId: 'gpt-5.5' }
  const api = { listModels: vi.fn(async () => ({ data: [model] })) }
  const onSelectionChange = vi.fn()
  const { result } = renderHook(() => useWorkbenchModels({ api, locked: false, onSelectionChange,
    selectionConfig: { modelName: model.name, modelType: 'public', options: {} } }))
  await waitFor(() => expect(result.current.selectedModel?.name).toBe(model.name))
  act(() => result.current.setSelectedModel(null))
  expect(onSelectionChange).toHaveBeenLastCalledWith(expect.objectContaining({ modelName: '', modelType: null }))
  expect(result.current.isSelectedModelUnavailable()).toBe(false)
})

test('a retained send-time validator observes model removal after catalog refresh', async () => {
  const model = { name: 'gpt-5.5-explicit', type: 'public' as const, modelId: 'gpt-5.5' }
  const api = { listModels: vi.fn().mockResolvedValueOnce({ data: [model] }).mockResolvedValue({ data: [] }) }
  const { result } = renderHook(() => useWorkbenchModels({ api, locked: false,
    selectionConfig: { modelName: model.name, modelType: 'public', options: {} } }))
  await waitFor(() => expect(result.current.selectedModel?.name).toBe(model.name))
  const validate = result.current.isSelectedModelUnavailable
  expect(validate()).toBe(false)
  act(() => window.dispatchEvent(new CustomEvent('wework:local-model-settings-changed')))
  await waitFor(() => expect(result.current.models).toHaveLength(0))
  expect(validate()).toBe(true)
})

test('a send-time validator from the previous scope cannot authorize the new scope', async () => {
  const model = { name: 'gpt-5.5', type: 'public' as const, modelId: 'gpt-5.5' }
  const api = { listModels: vi.fn(async () => ({ data: [model] })) }
  const { result, rerender } = renderHook(({ scopeKey }) => useWorkbenchModels({ api, locked: false, scopeKey,
    selectionConfig: { modelName: model.name, modelType: 'public', options: {} } }), { initialProps: { scopeKey: 'first' } })
  await waitFor(() => expect(result.current.selectedModel?.name).toBe(model.name))
  const previous = result.current.isSelectedModelUnavailable
  rerender({ scopeKey: 'second' })
  await waitFor(() => expect(result.current.isSelectionReady).toBe(true))
  expect(previous()).toBe(true)
  expect(result.current.isSelectedModelUnavailable()).toBe(false)
})

test('persisted follow-default selection keeps user options instead of adopting default options', async () => {
  const model = { name: 'gpt-5.5', type: 'public' as const, modelId: 'gpt-5.5' }
  const api = { listModels: vi.fn(async () => ({ data: [model] })) }
  const { result } = renderHook(() => useWorkbenchModels({ api, locked: false,
    selectionConfig: { modelName: '', modelType: null, options: { kcoderPermissionMode: 'ask' } },
    defaultSelectionConfig: () => ({ modelName: model.name, modelType: 'public', options: { kcoderPermissionMode: 'bypass' } }),
  }))
  await waitFor(() => expect(result.current.isSelectionReady).toBe(true))
  expect(result.current.selectedModel).toBeNull()
  expect(result.current.selectedModelOptions.kcoderPermissionMode).toBe('ask')
  expect(result.current.isSelectedModelUnavailable()).toBe(false)
})

test('follow-default intent survives catalog replacement while preserving permission choice', async () => {
  const first = { name: 'gpt-5.5-first', type: 'public' as const, modelId: 'gpt-5.5-first' }
  const second = { name: 'gpt-5.5-second', type: 'public' as const, modelId: 'gpt-5.5-second' }
  const api = { listModels: vi.fn().mockResolvedValueOnce({ data: [first] }).mockResolvedValue({ data: [second] }) }
  const onSelectionChange = vi.fn()
  const { result } = renderHook(() => useWorkbenchModels({ api, locked: false, onSelectionChange,
    selectionConfig: { modelName: '', modelType: null, options: { kcoderPermissionMode: 'ask' } },
    defaultSelectionConfig: models => ({ modelName: models[0]?.name ?? '', modelType: 'public', options: {} }),
  }))
  await waitFor(() => expect(result.current.isSelectionReady).toBe(true))
  act(() => window.dispatchEvent(new CustomEvent('wework:local-model-settings-changed')))
  await waitFor(() => expect(result.current.models[0]?.name).toBe(second.name))
  expect(result.current.selectedModel).toBeNull()
  expect(result.current.displaySelectedModel).toBeNull()
  expect(result.current.selectedModelOptions.kcoderPermissionMode).toBe('ask')
  expect(result.current.isSelectedModelUnavailable()).toBe(false)
  expect(onSelectionChange).not.toHaveBeenCalled()
})

test('selection intent is exposed only for a target with negotiated capability', async () => {
  const model = { name: 'gpt-5.5', type: 'public' as const, modelId: 'gpt-5.5', config: { supportsModelSelectionMode: true } }
  const api = { listModels: vi.fn(async () => ({ data: [model] })) }
  const { result } = renderHook(() => useWorkbenchModels({ api, locked: false,
    selectionConfig: { modelName: '', modelType: null, options: {} } }))
  await waitFor(() => expect(result.current.isSelectionReady).toBe(true))
  expect(result.current.getModelSelectionMode()).toBe('follow_target_default')
  act(() => result.current.setSelectedModel(model))
  expect(result.current.getModelSelectionMode()).toBe('explicit')
})


test('two mounted consumers use the same services modelApi without sharing cancellation ownership', async () => {
  let resolve!: (value: UnifiedModelListResponse) => void
  let signal!: AbortSignal
  const api = { listModels: vi.fn((_target, options) => {
    signal = options.signal
    return new Promise<UnifiedModelListResponse>(done => { resolve = done })
  }) }
  const opts = { api, locked: false, target: { deviceId: 'local', workspacePath: '/fixture', taskId: 'task-1' } }
  const first = renderHook(() => useWorkbenchModels(opts))
  const second = renderHook(() => useWorkbenchModels(opts))
  await waitFor(() => expect(api.listModels).toHaveBeenCalledTimes(1))
  first.unmount()
  expect(signal.aborted).toBe(false)
  await act(async () => resolve({ data: [{ name: 'model', type: 'public', modelId: 'gpt-5.5' }] }))
  expect(second.result.current.models).toHaveLength(1)
  second.unmount()
})
