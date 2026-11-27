import { invalidateModelCatalog, readModelCatalog } from './modelCatalogFlight'
import {
  normalizeRuntimeModelOptions as normalizeModelOptions,
  runtimeModelOptions,
} from '@/kcoder/modelOptions'
import type { ModelCatalogTarget } from '@/api/models'
import { useCallback, useEffect, useEffectEvent, useMemo, useRef, useState } from 'react'
import { useRetainedPageVisible } from '@/components/layout/retainedPageState'
import { getDefaultModelOptions, inferModelFamily, isSupportedModelFamily } from '@/lib/model-ui'
import { LOCAL_MODEL_SETTINGS_CHANGED_EVENT } from '@/features/model-settings/localModelSettings'
import { mergeModelCatalogs } from '@/api/modelCatalogMerge'
import {
  WORKBENCH_MODELS_CHANGED_EVENT,
  type WorkbenchModelsChangedDetail,
} from './workbenchCloudDataEvents'
import { findModelForSelection } from './runtimeContextUsage'
import type {
  ModelCompatibilityDisabledReason,
  ModelOptions,
  ModelSelectionConfig,
  UnifiedModel,
  UnifiedModelListResponse,
} from '@/types/api'

interface WorkbenchModelApi {
  listModels: (target?: ModelCatalogTarget) => Promise<UnifiedModelListResponse>
}

interface UseWorkbenchModelsOptions {
  api: WorkbenchModelApi
  target?: ModelCatalogTarget
  locked: boolean
  filterModel?: (model: UnifiedModel) => boolean
  scopeKey?: string
  persistSelection?: boolean
  selectionConfig?: ModelSelectionConfig | null
  defaultSelectionConfig?: (models: UnifiedModel[]) => ModelSelectionConfig | null
  selectionReady?: boolean
  onSelectionChange?: (selection: ModelSelectionConfig) => void
  onSelectionBlocked?: (
    reason: ModelCompatibilityDisabledReason | 'locked',
    model?: UnifiedModel | null
  ) => void
}

const DEFAULT_MODEL_SCOPE_KEY = 'default'

function findConfiguredModel(
  models: UnifiedModel[],
  selectionConfig?: ModelSelectionConfig | null
): UnifiedModel | null {
  return findModelForSelection(models, selectionConfig)
}

function toSelectionConfig(model: UnifiedModel, options: ModelOptions): ModelSelectionConfig {
  return {
    modelName: model.name,
    modelType: model.type,
    options,
  }
}

function toDefaultModelSelectionConfig(options: ModelOptions): ModelSelectionConfig {
  return {
    modelName: '',
    modelType: null,
    options,
  }
}

function areModelOptionsEqual(left: ModelOptions, right: ModelOptions): boolean {
  const leftKeys = Object.keys(left)
  const rightKeys = Object.keys(right)
  if (leftKeys.length !== rightKeys.length) return false
  return leftKeys.every(key => left[key] === right[key])
}

function getSelectionKey(
  models: UnifiedModel[],
  selectionConfig?: ModelSelectionConfig | null
): string {
  const modelsKey = models.map(model => `${model.type}:${model.name}`).join('|')
  const options = selectionConfig?.options ?? {}
  const optionsKey = Object.keys(options)
    .sort()
    .map(key => `${key}:${options[key]}`)
    .join('|')
  return [
    modelsKey,
    selectionConfig?.modelType ?? '',
    selectionConfig?.modelName ?? '',
    optionsKey,
  ].join('::')
}

export function useWorkbenchModels({
  api,
  target,
  locked,
  filterModel,
  scopeKey: requestedScopeKey = DEFAULT_MODEL_SCOPE_KEY,
  persistSelection = true,
  selectionConfig,
  defaultSelectionConfig,
  selectionReady = true,
  onSelectionChange,
  onSelectionBlocked,
}: UseWorkbenchModelsOptions) {
  const visible = useRetainedPageVisible()
  const catalogVisible = useEffectEvent(() => visible)
  const reconcileCatalog = useRef<(() => void) | null>(null)
  const cloudModels = useRef<{ source: WorkbenchModelApi; models: UnifiedModel[] } | null>(null)
  const reloadScope = target ? requestedScopeKey : ''
  const taskId = target?.taskId
  const deviceId = target?.deviceId
  const workspacePath = target?.workspacePath
  const targetReady = target === undefined || Boolean(deviceId)
  const catalogKey = JSON.stringify([deviceId, workspacePath, taskId])
  const scopeKey =
    deviceId || workspacePath ? `${requestedScopeKey}:${catalogKey}` : requestedScopeKey
  const [catalog, setCatalog] = useState<{ key: string; models: UnifiedModel[] } | null>(null)
  const availableModels = useMemo(
    () => (targetReady && catalog?.key === catalogKey ? catalog.models : []),
    [catalog, catalogKey, targetReady]
  )
  const models = useMemo(
    () => (filterModel ? availableModels.filter(filterModel) : availableModels),
    [availableModels, filterModel]
  )
  const [selectedModelByScope, setSelectedModelByScope] = useState<
    Record<string, UnifiedModel | null>
  >({})
  const [selectedModelOptionsByScope, setSelectedModelOptionsByScope] = useState<
    Record<string, ModelOptions>
  >({})
  const scopeModel = selectedModelByScope[scopeKey] ?? null
  const selectedModel =
    models.find(model => model.name === scopeModel?.name && model.type === scopeModel?.type) ?? null
  const selectedModelOptions = selectedModelOptionsByScope[scopeKey] ?? {}
  const selectedModelRef = useRef<Record<string, UnifiedModel | null>>({})
  const selectionIntentRef = useRef<Record<string, ModelSelectionConfig | null>>({})
  const [selectionIntentByScope, setSelectionIntentByScope] = useState<Record<string, ModelSelectionConfig | null>>({})
  const selectedModelOptionsRef = useRef<Record<string, ModelOptions>>({})
  const [catalogLoading, setCatalogLoading] = useState(false)
  const isLoading = !targetReady || catalogLoading
  const [error, setError] = useState<Error | null>(null)
  const [restoredSelectionKeyByScope, setRestoredSelectionKeyByScope] = useState<
    Record<string, string | null>
  >({})
  const effectiveSelectionConfig = useMemo(() => {
    if (selectionConfig != null) {
      return selectionConfig
    }
    return defaultSelectionConfig?.(models) ?? selectionConfig ?? null
  }, [defaultSelectionConfig, models, selectionConfig])
  const selectionKey = useMemo(
    () => getSelectionKey(models, effectiveSelectionConfig),
    [models, effectiveSelectionConfig]
  )
  const selectionMatchesConfig = Boolean(
    effectiveSelectionConfig?.modelName &&
    selectedModel &&
    selectedModel.name === effectiveSelectionConfig.modelName &&
    (!effectiveSelectionConfig.modelType ||
      selectedModel.type === effectiveSelectionConfig.modelType)
  )
  const isSelectionReady = useMemo(
    () =>
      selectionReady &&
      !isLoading &&
      (restoredSelectionKeyByScope[scopeKey] === selectionKey || selectionMatchesConfig),
    [
      isLoading,
      restoredSelectionKeyByScope,
      scopeKey,
      selectionMatchesConfig,
      selectionKey,
      selectionReady,
    ]
  )

  const restoreSelection = useCallback(
    (availableModels: UnifiedModel[], nextSelectionConfig?: ModelSelectionConfig | null) => {
      selectionIntentRef.current[scopeKey] = nextSelectionConfig ?? null
      setSelectionIntentByScope(current => ({ ...current, [scopeKey]: nextSelectionConfig ?? null }))
      const model = findConfiguredModel(availableModels, nextSelectionConfig)
      const restoredOptions = {
        ...(nextSelectionConfig?.options ?? {}),
        ...runtimeModelOptions(selectedModelOptionsRef.current[scopeKey] ?? {}),
      }
      const nextOptions = model ? normalizeModelOptions(model, restoredOptions) : restoredOptions
      selectedModelRef.current[scopeKey] = model
      selectedModelOptionsRef.current[scopeKey] = nextOptions
      setSelectedModelByScope(current => {
        if (current[scopeKey] === model) return current
        return { ...current, [scopeKey]: model }
      })
      setSelectedModelOptionsByScope(current => {
        if (areModelOptionsEqual(current[scopeKey] ?? {}, nextOptions)) return current
        return { ...current, [scopeKey]: nextOptions }
      })
    },
    [scopeKey]
  )

  useEffect(() => {
    if (!targetReady) return
    let cancelled = false

    let requestGeneration = 0
    let subscription: AbortController | undefined
    let refreshPending = true
    const applyCloudModels = () => {
      const update = cloudModels.current
      if (!update || update.source !== api) return
      const supportedCloudModels = update.models.filter(isSupportedModelFamily)
      setCatalog(current => {
        if (!current || current.key !== catalogKey) return current
        const models = mergeModelCatalogs(current.models, supportedCloudModels)
        return models.length === current.models.length &&
          models.every((model, index) => model === current.models[index])
          ? current
          : { ...current, models }
      })
    }
    async function loadModels(event?: Event) {
      if (event) invalidateModelCatalog(api, event)
      refreshPending ||= Boolean(event)
      if (refreshPending) setCatalogLoading(true)
      if (!catalogVisible()) {
        if (subscription) {
          refreshPending = true
          ++requestGeneration
          subscription.abort()
          subscription = undefined
        }
        return
      }
      if (!refreshPending) return
      refreshPending = false
      subscription?.abort()
      subscription = new AbortController()
      const requestId = ++requestGeneration
      setError(null)
      try {
        const response = await readModelCatalog(api, JSON.stringify([catalogKey, reloadScope]),
          deviceId
            ? { deviceId, workspacePath, ...(taskId ? { taskId } : {}) }
            : undefined,
          subscription.signal
        )
        if (!cancelled && requestId === requestGeneration) {
          const filtered = mergeModelCatalogs(
            response.data.filter(isSupportedModelFamily),
            cloudModels.current?.source === api
              ? cloudModels.current.models.filter(isSupportedModelFamily)
              : []
          )
          setCatalog({ key: catalogKey, models: filtered })
        }
      } catch (nextError) {
        if (!cancelled && requestId === requestGeneration) {
          setError(nextError instanceof Error ? nextError : new Error('Failed to load models'))
        }
      } finally {
        if (!cancelled && requestId === requestGeneration) {
          subscription = undefined
          setCatalogLoading(false)
        }
      }
    }

    const onCloudModelsChanged = (event: Event) => {
      const detail = (event as CustomEvent<WorkbenchModelsChangedDetail>).detail
      if (!detail || detail.source !== api) return
      cloudModels.current = { source: api, models: detail.models }
      if (catalogVisible()) applyCloudModels()
    }

    // Visibility wakes the same owner; it does not invalidate a completed read.
    reconcileCatalog.current = () => {
      if (catalogVisible()) applyCloudModels()
      void loadModels()
    }
    void loadModels()
    window.addEventListener(LOCAL_MODEL_SETTINGS_CHANGED_EVENT, loadModels)
    window.addEventListener(WORKBENCH_MODELS_CHANGED_EVENT, onCloudModelsChanged)
    return () => {
      cancelled = true
      reconcileCatalog.current = null
      subscription?.abort()
      window.removeEventListener(LOCAL_MODEL_SETTINGS_CHANGED_EVENT, loadModels)
      window.removeEventListener(WORKBENCH_MODELS_CHANGED_EVENT, onCloudModelsChanged)
    }
  }, [api, catalogKey, deviceId, workspacePath, taskId, reloadScope, targetReady])

  useEffect(() => { reconcileCatalog.current?.() }, [visible])

  useEffect(() => {
    if (!selectionReady) {
      return
    }

    let cancelled = false

    async function syncSelection() {
      await Promise.resolve()
      if (!cancelled) {
        const hasScopeSelection =
          Object.prototype.hasOwnProperty.call(selectedModelRef.current, scopeKey) ||
          Object.prototype.hasOwnProperty.call(selectedModelOptionsRef.current, scopeKey)
        const scopeSelectionAlreadyRestored = restoredSelectionKeyByScope[scopeKey] === selectionKey
        if (!hasScopeSelection || !scopeSelectionAlreadyRestored) {
          restoreSelection(models, effectiveSelectionConfig)
        }
        setRestoredSelectionKeyByScope(current =>
          current[scopeKey] === selectionKey ? current : { ...current, [scopeKey]: selectionKey }
        )
      }
    }

    syncSelection()
    return () => {
      cancelled = true
    }
  }, [
    effectiveSelectionConfig,
    models,
    restoreSelection,
    restoredSelectionKeyByScope,
    scopeKey,
    selectionKey,
    selectionReady,
  ])

  const applySelectedModel = useCallback(
    (
      model: UnifiedModel | null,
      resolveOptions: (
        model: UnifiedModel | null,
        currentModel: UnifiedModel | null,
        currentOptions: ModelOptions
      ) => ModelOptions
    ) => {
      if (locked) {
        onSelectionBlocked?.('locked', model)
        return
      }
      if (model?.compatibilityDisabled) {
        onSelectionBlocked?.(model.compatibilityDisabledReason ?? 'runtime_family_mismatch', model)
        return
      }
      const currentSelection = selectedModelRef.current[scopeKey] ?? null
      const currentOptions = selectedModelOptionsRef.current[scopeKey] ?? {}
      const nextOptions = resolveOptions(model, currentSelection, currentOptions)
      selectionIntentRef.current[scopeKey] = model ? toSelectionConfig(model, nextOptions) : toDefaultModelSelectionConfig(nextOptions)
      setSelectionIntentByScope(current => ({ ...current, [scopeKey]: model ? toSelectionConfig(model, nextOptions) : toDefaultModelSelectionConfig(nextOptions) }))
      selectedModelRef.current[scopeKey] = model
      selectedModelOptionsRef.current[scopeKey] = nextOptions
      setSelectedModelByScope(current => ({ ...current, [scopeKey]: model }))
      setSelectedModelOptionsByScope(current => ({ ...current, [scopeKey]: nextOptions }))
      if (persistSelection) {
        onSelectionChange?.(model ? toSelectionConfig(model, nextOptions) : toDefaultModelSelectionConfig(nextOptions))
      }
    },
    [locked, onSelectionBlocked, onSelectionChange, persistSelection, scopeKey, deviceId, taskId]
  )

  const setSelectedModel = useCallback(
    (model: UnifiedModel | null) => {
      applySelectedModel(model, (nextModel, currentModel, currentOptions) => {
        const currentFamily = currentModel ? inferModelFamily(currentModel) : null
        const nextFamily = nextModel ? inferModelFamily(nextModel) : null
        return currentFamily === nextFamily
          ? normalizeModelOptions(nextModel, currentOptions)
          : { ...getDefaultModelOptions(nextModel), ...runtimeModelOptions(currentOptions) }
      })
    },
    [applySelectedModel]
  )

  const setSelectedModelAndOptions = useCallback(
    (model: UnifiedModel, options: ModelOptions) => {
      applySelectedModel(model, (nextModel, _currentModel, currentOptions) =>
        normalizeModelOptions(nextModel, { ...runtimeModelOptions(currentOptions), ...options })
      )
    },
    [applySelectedModel]
  )

  const setSelectedModelOption = useCallback(
    (optionId: string, value: string) => {
      if (locked) return
      const nextOptions = {
        ...(selectedModelOptionsRef.current[scopeKey] ?? {}),
        [optionId]: value,
      }
      const currentModel = selectedModelRef.current[scopeKey] ?? null
      selectedModelOptionsRef.current[scopeKey] = nextOptions
      setSelectedModelOptionsByScope(current => ({ ...current, [scopeKey]: nextOptions }))
      if (!persistSelection) return
      if (currentModel) {
        onSelectionChange?.(toSelectionConfig(currentModel, nextOptions))
      } else {
        const intent = selectionIntentRef.current[scopeKey]
        onSelectionChange?.(intent?.modelName ? { ...intent, options: nextOptions } : toDefaultModelSelectionConfig(nextOptions))
      }
    },
    [locked, onSelectionChange, persistSelection, scopeKey]
  )

  const setSelectionForScope = useCallback(
    (targetScopeKey: string, model: UnifiedModel | null, options: ModelOptions = {}) => {
      const nextOptions = model ? normalizeModelOptions(model, options) : options
      selectionIntentRef.current[targetScopeKey] = model ? toSelectionConfig(model, nextOptions) : toDefaultModelSelectionConfig(nextOptions)
      setSelectionIntentByScope(current => ({ ...current, [targetScopeKey]: model ? toSelectionConfig(model, nextOptions) : toDefaultModelSelectionConfig(nextOptions) }))
      selectedModelRef.current[targetScopeKey] = model
      selectedModelOptionsRef.current[targetScopeKey] = nextOptions
      setSelectedModelByScope(current => ({ ...current, [targetScopeKey]: model }))
      setSelectedModelOptionsByScope(current => ({ ...current, [targetScopeKey]: nextOptions }))
      setRestoredSelectionKeyByScope(current => ({ ...current, [targetScopeKey]: selectionKey }))
    },
    [selectionKey]
  )

  const selectionValidationRef = useRef({ scopeKey, selectionKey, models, effectiveSelectionConfig,
    restoredKey: restoredSelectionKeyByScope[scopeKey] })
  useEffect(() => {
    selectionValidationRef.current = { scopeKey, selectionKey, models, effectiveSelectionConfig,
      restoredKey: restoredSelectionKeyByScope[scopeKey] }
  }, [effectiveSelectionConfig, models, restoredSelectionKeyByScope, scopeKey, selectionKey])

  const isSelectedModelUnavailable = useCallback(() => {
    const current = selectionValidationRef.current
    // An asynchronous sender from a previous scope must not select in the new scope.
    if (current.scopeKey !== scopeKey) return true
    const intent = current.restoredKey === current.selectionKey
      ? selectionIntentRef.current[scopeKey] : current.effectiveSelectionConfig
    return Boolean(intent?.modelName && !findConfiguredModel(current.models, intent))
  }, [scopeKey])

  const displayIntent = restoredSelectionKeyByScope[scopeKey] === selectionKey
    ? selectionIntentByScope[scopeKey] : effectiveSelectionConfig
  // This descriptor is for presentation only; it is absent from the executable catalog.
  const displaySelectedModel: UnifiedModel | null = selectedModel ?? (
    !isLoading && catalog?.key === catalogKey && displayIntent?.modelName
      ? { name: displayIntent.modelName, type: displayIntent.modelType ?? 'public',
          displayName: displayIntent.modelName, compatibilityDisabled: true,
          compatibilityDisabledReason: 'unavailable' }
      : null
  )

  const getModelSelectionMode = useCallback((): 'explicit' | 'follow_target_default' | undefined => {
    const current = selectionValidationRef.current
    if (current.scopeKey !== scopeKey || !current.models.some(model => model.config?.supportsModelSelectionMode === true)) return undefined
    const intent = current.restoredKey === current.selectionKey
      ? selectionIntentRef.current[scopeKey] : current.effectiveSelectionConfig
    return intent ? (intent.modelName ? 'explicit' : 'follow_target_default') : undefined
  }, [scopeKey])

  const getSelectedModel = useCallback(() => selectedModelRef.current[scopeKey] ?? null, [scopeKey])
  const getSelectedModelOptions = useCallback(
    () => selectedModelOptionsRef.current[scopeKey] ?? {},
    [scopeKey]
  )

  return {
    models,
    selectedModel,
    displaySelectedModel,
    selectedModelOptions,
    isSelectionReady,
    setSelectedModel,
    setSelectedModelAndOptions,
    setSelectedModelOption,
    setSelectionForScope,
    getSelectedModel,
    getModelSelectionMode,    isSelectedModelUnavailable,
    getSelectedModelOptions,
    isLoading,
    error: targetReady ? error : null,
  }
}
