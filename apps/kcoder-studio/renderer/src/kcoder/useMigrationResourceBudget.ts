import { useEffect, useLayoutEffect, useMemo, useSyncExternalStore } from 'react'
import { createResourceBudgetController } from '../../../shared/migrationResourceBudgetController.mjs'
import { createResourceBudgetStorage } from '../../../shared/migrationResourceBudgetStorage.mjs'
import { validResourceIntent, validResourceCall } from '../../../shared/migrationResourceBudget'
import { createMigrationApi } from './gatewayMigration'

class BudgetIntentScope {
  readonly key: string
  constructor(key: string) { this.key = key }
  private predicate: () => boolean = () => false
  private allowed = false
  update(predicate: () => boolean, allowed: boolean) { this.predicate = predicate; this.allowed = allowed }
  invalidate() { this.predicate = () => false; this.allowed = false }
  isCurrent = () => this.predicate()
  mutable = () => this.allowed
}

/** The namespace includes the account, complete target descriptor and Relay mount. */
export function useMigrationResourceBudget(deviceId: string, workspacePath: string | undefined, scope: string, jobId: string, planId: string | null | undefined, isCurrent: () => boolean, canIncrease: boolean) {
  const latest = useMemo(() => new BudgetIntentScope(JSON.stringify([deviceId, workspacePath, scope, jobId, planId])), [deviceId, workspacePath, scope, jobId, planId])
  useLayoutEffect(() => { latest.update(isCurrent, canIncrease); return () => latest.invalidate() }, [latest, isCurrent, canIncrease])
  const controller = useMemo(() => {
    const api = createMigrationApi(deviceId, workspacePath)
    return createResourceBudgetController({
      api: { read: api.resourcesRead, increase: api.resourcesIncrease },
      storage: createResourceBudgetStorage({ storage: { getItem: key => window.localStorage.getItem(key) }, indexedDB: globalThis.indexedDB, isCurrent: latest.isCurrent }),
      scope, jobId, planId, isCurrent: latest.isCurrent, canIncrease: latest.mutable,
      createRequestId: () => crypto.randomUUID(), validIntent: validResourceIntent, validView: (query, view) => validResourceCall('migration/batch/resources/read', query, view),
    })
  }, [deviceId, workspacePath, scope, jobId, planId, latest])
  const state = useSyncExternalStore(controller.subscribe, controller.getSnapshot, controller.getSnapshot)
  useEffect(() => { controller.activate(); void controller.read(); return () => controller.dispose() }, [controller])
  return { controller, state }
}
