import { LOCAL_MODEL_SETTINGS_CHANGED_EVENT } from '@/features/model-settings/localModelSettings'
import { act, renderHook, waitFor } from '@testing-library/react'
import { expect, test, vi } from 'vitest'
import { useWorkbenchModels } from './useWorkbenchModels'
import {
  notifyWorkbenchModelsChanged,
  WORKBENCH_MODELS_CHANGED_EVENT,
} from './workbenchCloudDataEvents'
import type { UnifiedModelListResponse } from '@/types/api'
import type { ModelCatalogTarget } from '@/api/models'
import type { ReactNode } from 'react'
import { RetainedPageActive } from '@/components/layout/retainedPageState'

test('hidden startup defers model reads and reconciles the latest configuration once visible', async () => {
  const visibility = vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('hidden')
  const api = { listModels: vi.fn(async () => ({ data: [{ name: 'current', type: 'public' as const }] })) }
  const view = renderHook(() => useWorkbenchModels({ api, locked: false }))
  try {
    await act(async () => {
      for (let index = 0; index < 100; index++) window.dispatchEvent(new Event(LOCAL_MODEL_SETTINGS_CHANGED_EVENT))
    })
    expect(api.listModels).not.toHaveBeenCalled()
    expect(view.result.current.isLoading).toBe(true)
    expect(view.result.current.isSelectionReady).toBe(false)
    visibility.mockReturnValue('visible')
    await act(async () => { document.dispatchEvent(new Event('visibilitychange')) })
    await waitFor(() => expect(view.result.current.models[0]?.name).toBe('current'))
    expect(api.listModels).toHaveBeenCalledTimes(1)
  } finally { view.unmount(); visibility.mockRestore() }
})

test('hidden local-settings invalidation retires its old read without reading again on an unchanged foreground', async () => {
  const visibility = vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('visible')
  const reads: Array<{ signal: AbortSignal; resolve: (value: UnifiedModelListResponse) => void }> = []
  const api = { listModels: vi.fn((_target, options) => new Promise<UnifiedModelListResponse>(resolve => {
    reads.push({ signal: options.signal, resolve })
  })) }
  const view = renderHook(() => useWorkbenchModels({ api, locked: false }))
  try {
    await waitFor(() => expect(reads).toHaveLength(1))
    visibility.mockReturnValue('hidden')
    await act(async () => {
      document.dispatchEvent(new Event('visibilitychange'))
      window.dispatchEvent(new Event(LOCAL_MODEL_SETTINGS_CHANGED_EVENT))
    })
    expect(reads[0].signal.aborted).toBe(true)
    expect(reads).toHaveLength(1)
    await act(async () => reads[0].resolve({ data: [{ name: 'retired', type: 'public' }] }))
    expect(view.result.current.models).toEqual([])
    visibility.mockReturnValue('visible')
    await act(async () => { document.dispatchEvent(new Event('visibilitychange')) })
    await waitFor(() => expect(reads).toHaveLength(2))
    await act(async () => reads[1].resolve({ data: [{ name: 'current', type: 'public' }] }))
    expect(view.result.current.models[0]?.name).toBe('current')
    for (const value of ['hidden', 'visible'] as const) {
      visibility.mockReturnValue(value)
      await act(async () => { document.dispatchEvent(new Event('visibilitychange')) })
    }
    expect(reads).toHaveLength(2)
  } finally { view.unmount(); visibility.mockRestore() }
})

test('an inactive retained owner defers catalog reads until the current target is shown', async () => {
  let active = false
  const api = { listModels: vi.fn(async () => ({ data: [] })) }
  const view = renderHook(({ target }: { target: ModelCatalogTarget }) => useWorkbenchModels({ api, target, locked: false }), {
    initialProps: { target: { deviceId: 'before', workspacePath: '/before' } },
    wrapper: ({ children }: { children: ReactNode }) => <RetainedPageActive.Provider value={active}>{children}</RetainedPageActive.Provider>,
  })
  try {
    view.rerender({ target: { deviceId: 'current', workspacePath: '/current' } })
    await act(async () => { window.dispatchEvent(new Event(LOCAL_MODEL_SETTINGS_CHANGED_EVENT)) })
    expect(api.listModels).not.toHaveBeenCalled()
    active = true
    view.rerender({ target: { deviceId: 'current', workspacePath: '/current' } })
    await waitFor(() => expect(api.listModels).toHaveBeenCalledExactlyOnceWith(
      { deviceId: 'current', workspacePath: '/current' }, { signal: expect.any(AbortSignal) }))
  } finally { view.unmount() }
})

test('hiding one catalog consumer releases only its waiter and cannot consume the surviving reply', async () => {
  let active = true
  let complete!: (value: UnifiedModelListResponse) => void
  let signal!: AbortSignal
  const api = { listModels: vi.fn((_target, options) => {
    signal = options.signal
    return new Promise<UnifiedModelListResponse>(resolve => { complete = resolve })
  }) }
  const useModels = () => useWorkbenchModels({ api, locked: false })
  const first = renderHook(useModels, {
    wrapper: ({ children }: { children: ReactNode }) => <RetainedPageActive.Provider value={active}>{children}</RetainedPageActive.Provider>,
  })
  const second = renderHook(useModels)
  try {
    await waitFor(() => expect(api.listModels).toHaveBeenCalledTimes(1))
    active = false
    first.rerender()
    expect(signal.aborted).toBe(false)
    await act(async () => complete({ data: [{ name: 'current', type: 'public' }] }))
    expect(first.result.current.models).toEqual([])
    expect(second.result.current.models[0]?.name).toBe('current')
    expect(second.result.current.error).toBeNull()
  } finally { first.unmount(); second.unmount() }
})

test.each<ModelCatalogTarget>([{}, { workspacePath: '/unresolved' }, { taskId: 'unresolved' }])(
  'an unresolved explicit target never reads the implicit default catalog (%j)', async target => {
    const api = { listModels: vi.fn(async () => ({ data: [{ name: 'model', type: 'public' as const }] })) }
    const view = renderHook(({ target }: { target: ModelCatalogTarget }) =>
      useWorkbenchModels({ api, target, locked: false }), { initialProps: { target } })
    expect(api.listModels).not.toHaveBeenCalled()
    expect(view.result.current.isSelectionReady).toBe(false)
    expect(view.result.current.isLoading).toBe(true)
    act(() => window.dispatchEvent(new CustomEvent(LOCAL_MODEL_SETTINGS_CHANGED_EVENT)))
    await act(async () => { await Promise.resolve() })
    expect(api.listModels).not.toHaveBeenCalled()
    expect(view.result.current.models).toEqual([])
    const resolved = { deviceId: 'selected-ssh', workspacePath: '/selected' }
    view.rerender({ target: resolved })
    await waitFor(() => expect(view.result.current.isLoading).toBe(false))
    expect(api.listModels).toHaveBeenCalledExactlyOnceWith(resolved, { signal: expect.any(AbortSignal) })
    expect(view.result.current.models).toHaveLength(1)
  }
)

test('losing explicit target ownership cancels its pending catalog without falling back to the default', async () => {
  const reads: Array<{ signal: AbortSignal; resolve: (value: UnifiedModelListResponse) => void }> = []
  const api = { listModels: vi.fn((_target, options) => new Promise<UnifiedModelListResponse>(resolve => {
    reads.push({ signal: options.signal, resolve })
  })) }
  const first = { deviceId: 'first', workspacePath: '/first' }
  const view = renderHook(({ target }: { target: ModelCatalogTarget }) =>
    useWorkbenchModels({ api, target, locked: false }), { initialProps: { target: first } })
  await waitFor(() => expect(reads).toHaveLength(1))
  view.rerender({ target: {} })
  expect(reads[0].signal.aborted).toBe(true)
  await act(async () => reads[0].resolve({ data: [{ name: 'old-owner', type: 'public' }] }))
  expect(api.listModels).toHaveBeenCalledTimes(1)
  expect(view.result.current.models).toEqual([])
  expect(view.result.current.isSelectionReady).toBe(false)
  const next = { deviceId: 'second', workspacePath: '/second' }
  view.rerender({ target: next })
  await waitFor(() => expect(reads).toHaveLength(2))
  await act(async () => reads[1].resolve({ data: [{ name: 'new-owner', type: 'public' }] }))
  expect(view.result.current.models[0]?.name).toBe('new-owner')
  expect(api.listModels).toHaveBeenLastCalledWith(next, { signal: reads[1].signal })
})

test('an unresolved target does not retain the previous target catalog error', async () => {
  const api = { listModels: vi.fn().mockRejectedValueOnce(new Error('Previous target unavailable'))
    .mockResolvedValue({ data: [] }) }
  const view = renderHook(({ target }: { target: ModelCatalogTarget }) =>
    useWorkbenchModels({ api, target, locked: false }), { initialProps: { target: { deviceId: 'previous' } } })
  await waitFor(() => expect(view.result.current.error?.message).toBe('Previous target unavailable'))
  view.rerender({ target: {} })
  expect(view.result.current.error).toBeNull()
  expect(view.result.current.isLoading).toBe(true)
  expect(api.listModels).toHaveBeenCalledTimes(1)
  view.rerender({ target: { deviceId: 'next' } })
  await waitFor(() => expect(view.result.current.isLoading).toBe(false))
  expect(view.result.current.error).toBeNull()
})

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
  act(() => window.dispatchEvent(new CustomEvent(LOCAL_MODEL_SETTINGS_CHANGED_EVENT)))
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
  act(() => window.dispatchEvent(new CustomEvent(LOCAL_MODEL_SETTINGS_CHANGED_EVENT)))
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
  act(() => window.dispatchEvent(new CustomEvent(LOCAL_MODEL_SETTINGS_CHANGED_EVENT)))
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

test(LOCAL_MODEL_SETTINGS_CHANGED_EVENT + ' shares the latest notification cohort across views', async () => {
    const initial = { data: [{ name: 'gpt-5.5', type: 'public' as const, modelId: 'initial' }] }
    const current = { data: [{ name: 'gpt-5.5', type: 'public' as const, modelId: 'current' }] }
    let finish!: (value: UnifiedModelListResponse) => void
    let signal!: AbortSignal
    const api = { listModels: vi.fn<(target?: ModelCatalogTarget, options?: { signal?: AbortSignal }) => Promise<UnifiedModelListResponse>>()
      .mockResolvedValueOnce(initial)
      .mockImplementationOnce((_target, options) => {
        signal = options!.signal!
        return new Promise(resolve => { finish = resolve })
      })
      .mockResolvedValue(current) }
    const target = { deviceId: 'model-notice-owned', workspacePath: '/owned/model-notice' }
    const useObservedModels = () => useWorkbenchModels({ api, target, locked: false,
      persistSelection: false, scopeKey: 'model-notice-cohort' })
    const first = renderHook(useObservedModels), second = renderHook(useObservedModels)
    let reopened: typeof first | undefined
    try {
      await waitFor(() => {
        expect(first.result.current.models[0]?.modelId).toBe('initial')
        expect(second.result.current.models[0]?.modelId).toBe('initial')
      })
      expect(api.listModels).toHaveBeenCalledTimes(1)
      await act(async () => {
        for (let index = 0; index < 100; index++) window.dispatchEvent(new Event(LOCAL_MODEL_SETTINGS_CHANGED_EVENT))
      })
      expect(api.listModels).toHaveBeenCalledTimes(2)
      act(() => first.unmount())
      expect(signal.aborted).toBe(false)
      await act(async () => finish(current))
      await waitFor(() => expect(second.result.current.models[0]?.modelId).toBe('current'))
      expect(second.result.current.error).toBeNull()
      reopened = renderHook(useObservedModels)
      await waitFor(() => expect(reopened!.result.current.models[0]?.modelId).toBe('current'))
      expect(api.listModels).toHaveBeenCalledTimes(3)
      expect(api.listModels).toHaveBeenLastCalledWith(target, { signal: expect.any(AbortSignal) })
    } finally { finish?.(current); first.unmount(); second.unmount(); reopened?.unmount() }
  }
)

test('cloud catalog completion updates the current catalog without a Native read', async () => {
  const local = { name: 'local', type: 'runtime' as const }
  const cloud = { name: 'cloud', type: 'public' as const }
  const api = { listModels: vi.fn(async () => ({ data: [local] })) }
  const view = renderHook(() => useWorkbenchModels({ api, locked: false }))
  try {
    await waitFor(() => expect(view.result.current.models).toEqual([local]))
    act(() => notifyWorkbenchModelsChanged({ source: api, models: [cloud] }))
    await waitFor(() => expect(view.result.current.models).toEqual([local, cloud]))
    act(() => notifyWorkbenchModelsChanged({ source: {}, models: [{ name: 'stale', type: 'public' }] }))
    expect(view.result.current.models).toEqual([local, cloud])
    expect(api.listModels).toHaveBeenCalledTimes(1)
  } finally { view.unmount() }
})

test('hidden cloud catalog completion is applied when the retained page returns', async () => {
  const visibility = vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('visible')
  const local = { name: 'local', type: 'runtime' as const }
  const cloud = { name: 'cloud', type: 'public' as const }
  const api = { listModels: vi.fn(async () => ({ data: [local] })) }
  const view = renderHook(() => useWorkbenchModels({ api, locked: false }))
  try {
    await waitFor(() => expect(view.result.current.models).toEqual([local]))
    visibility.mockReturnValue('hidden')
    await act(async () => { document.dispatchEvent(new Event('visibilitychange')) })
    act(() => notifyWorkbenchModelsChanged({ source: api, models: [cloud] }))
    expect(api.listModels).toHaveBeenCalledTimes(1)
    visibility.mockReturnValue('visible')
    await act(async () => { document.dispatchEvent(new Event('visibilitychange')) })
    await waitFor(() => expect(view.result.current.models).toEqual([local, cloud]))
    expect(api.listModels).toHaveBeenCalledTimes(1)
  } finally { view.unmount(); visibility.mockRestore() }
})

test('cloud catalog completion racing a local read is included in its result', async () => {
  const local = { name: 'local', type: 'runtime' as const }
  const cloud = { name: 'cloud', type: 'public' as const }
  let finish!: (value: UnifiedModelListResponse) => void
  const api = { listModels: vi.fn(() => new Promise<UnifiedModelListResponse>(resolve => { finish = resolve })) }
  const view = renderHook(() => useWorkbenchModels({ api, locked: false }))
  try {
    await waitFor(() => expect(api.listModels).toHaveBeenCalledTimes(1))
    act(() => notifyWorkbenchModelsChanged({ source: api, models: [cloud] }))
    await act(async () => finish({ data: [local] }))
    await waitFor(() => expect(view.result.current.models).toEqual([local, cloud]))
    expect(api.listModels).toHaveBeenCalledTimes(1)
  } finally { view.unmount() }
})

test('local settings refresh shares the latest notification cohort across views', async () => {
  const initial = { data: [{ name: 'gpt-5.5', type: 'public' as const, modelId: 'initial' }] }
  const current = { data: [{ name: 'gpt-5.5', type: 'public' as const, modelId: 'current' }] }
  let finish!: (value: UnifiedModelListResponse) => void
  let signal!: AbortSignal
  const api = { listModels: vi.fn<(target?: ModelCatalogTarget, options?: { signal?: AbortSignal }) => Promise<UnifiedModelListResponse>>()
    .mockResolvedValueOnce(initial)
    .mockImplementationOnce((_target, options) => {
      signal = options!.signal!
      return new Promise(resolve => { finish = resolve })
    })
    .mockResolvedValue(current) }
  const target = { deviceId: 'model-notice-owned', workspacePath: '/owned/model-notice' }
  const useObservedModels = () => useWorkbenchModels({ api, target, locked: false,
    persistSelection: false, scopeKey: 'model-notice-cohort' })
  const first = renderHook(useObservedModels), second = renderHook(useObservedModels)
  let reopened: typeof first | undefined
  try {
    await waitFor(() => {
      expect(first.result.current.models[0]?.modelId).toBe('initial')
      expect(second.result.current.models[0]?.modelId).toBe('initial')
    })
    expect(api.listModels).toHaveBeenCalledTimes(1)
    await act(async () => {
      for (let index = 0; index < 100; index++) {
        window.dispatchEvent(new Event(LOCAL_MODEL_SETTINGS_CHANGED_EVENT))
      }
    })
    expect(api.listModels).toHaveBeenCalledTimes(2)
    act(() => first.unmount())
    expect(signal.aborted).toBe(false)
    await act(async () => finish(current))
    await waitFor(() => expect(second.result.current.models[0]?.modelId).toBe('current'))
    expect(second.result.current.error).toBeNull()
    reopened = renderHook(useObservedModels)
    await waitFor(() => expect(reopened!.result.current.models[0]?.modelId).toBe('current'))
    expect(api.listModels).toHaveBeenCalledTimes(3)
    expect(api.listModels).toHaveBeenLastCalledWith(target, { signal: expect.any(AbortSignal) })
  } finally { finish?.(current); first.unmount(); second.unmount(); reopened?.unmount() }
})
