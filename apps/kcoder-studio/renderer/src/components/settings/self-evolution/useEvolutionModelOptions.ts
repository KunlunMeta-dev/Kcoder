import { useContext, useEffect, useState } from 'react'
import { LOCAL_MODEL_SETTINGS_CHANGED_EVENT } from '@/features/model-settings/localModelSettings'
import { invalidateModelCatalog, readModelCatalog } from '@/features/workbench/modelCatalogFlight'
import { WorkbenchContext } from '@/features/workbench/useWorkbench'
import { WORKBENCH_MODELS_CHANGED_EVENT } from '@/features/workbench/workbenchCloudDataEvents'
import {
  configuredModelOptions,
  type ConfiguredModelOption,
} from '@/kcoder/evolution/evolutionSettingsModel'

export interface EvolutionModelOptionsState {
  options: ConfiguredModelOption[]
  loading: boolean
  failed: boolean
}

/**
 * Reads the same target model catalog as the session model picker. It never
 * selects a model; callers keep the stored reference even when it disappears.
 */
export function useEvolutionModelOptions(deviceId: string): EvolutionModelOptionsState {
  const api = useContext(WorkbenchContext)?.services.modelApi
  const [state, setState] = useState<{
    deviceId: string
    options: ConfiguredModelOption[]
    failed: boolean
  } | null>(null)
  useEffect(() => {
    if (!api) return
    let cancelled = false
    let controller: AbortController | undefined
    const load = async (event?: Event) => {
      if (event) invalidateModelCatalog(api, event)
      controller?.abort()
      const own = new AbortController()
      controller = own
      try {
        const response = await readModelCatalog(
          api,
          JSON.stringify(['self-evolution', deviceId]),
          { deviceId },
          own.signal
        )
        if (!cancelled && controller === own)
          setState({ deviceId, options: configuredModelOptions(response.data), failed: false })
      } catch {
        if (!cancelled && controller === own) setState({ deviceId, options: [], failed: true })
      }
    }
    void load()
    window.addEventListener(LOCAL_MODEL_SETTINGS_CHANGED_EVENT, load)
    window.addEventListener(WORKBENCH_MODELS_CHANGED_EVENT, load)
    return () => {
      cancelled = true
      controller?.abort()
      window.removeEventListener(LOCAL_MODEL_SETTINGS_CHANGED_EVENT, load)
      window.removeEventListener(WORKBENCH_MODELS_CHANGED_EVENT, load)
    }
  }, [api, deviceId])
  if (!api) return { options: [], loading: false, failed: true }
  if (state?.deviceId !== deviceId) return { options: [], loading: true, failed: false }
  return { options: state.options, loading: false, failed: state.failed }
}
