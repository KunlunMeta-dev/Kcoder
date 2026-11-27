import type { LocalExecutorStatus, requestLocalExecutor } from '@/host/localExecutor'
import { runtimeMethodForCurrentHost } from '@/kcoder/legacyRuntimeAbi'
import {
  listLocalModelConfigs,
  markLocalModelCatalogReady,
  reconcileLocalModelCatalogRuntime,
} from '@/features/model-settings/localModelSettings'

/** Legacy model reconciliation belongs to one local services instance, never Gateway preflight. */
export function createLocalModelCatalogReconciliation(request: typeof requestLocalExecutor) {
  let catalogReconciliationKey = ''
  let catalogReconciliationAttemptedAt = 0
  return async (status: LocalExecutorStatus) => {
    reconcileLocalModelCatalogRuntime(status.runtimeInstanceId)
    const catalogModels = listLocalModelConfigs().filter(model => model.catalogEntry)
    const pendingCatalogModels = catalogModels.filter(
      model => !model.catalogReady && model.catalogEntry
    )
    const reconciliationKey = pendingCatalogModels
      .map(model => `${status.runtimeInstanceId ?? ''}:${model.id}:${model.updatedAt}`)
      .sort()
      .join('|')
    const now = Date.now()
    const shouldReconcile =
      reconciliationKey &&
      (reconciliationKey !== catalogReconciliationKey ||
        now - catalogReconciliationAttemptedAt >= 30_000)
    if (shouldReconcile) {
      catalogReconciliationKey = reconciliationKey
      catalogReconciliationAttemptedAt = now
      try {
        await request(runtimeMethodForCurrentHost('catalogCustomWrite'), {
          models: catalogModels.flatMap(model =>
            model.catalogEntry ? [model.catalogEntry] : []
          ),
        })
        const restart = await request<{
          restarted?: boolean
        }>(runtimeMethodForCurrentHost('appServerRestart'), { ifIdle: true })
        if (restart.restarted) markLocalModelCatalogReady(pendingCatalogModels)
      } catch (error) {
        console.error('Local model catalog reconciliation failed', error)
      }
    }
  }
}
