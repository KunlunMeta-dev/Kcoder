import { useEffect, useLayoutEffect, useMemo, useSyncExternalStore } from 'react'
import { ProjectMcpCatalogController } from '../../../shared/migrationProjectMcp'
import type { createMigrationApi } from './gatewayMigration'

class CatalogOwner {
  private predicate: () => boolean = () => false
  update(predicate: () => boolean) { this.predicate = predicate }
  invalidate() { this.predicate = () => false }
  isCurrent = () => this.predicate()
}

export function useMigrationProjectMcpCatalog(
  api: ReturnType<typeof createMigrationApi>, jobId: string | undefined, isCurrent: () => boolean
) {
  const owner = useMemo(() => new CatalogOwner(), [])
  useLayoutEffect(() => { owner.update(isCurrent); return () => owner.invalidate() }, [owner, isCurrent])
  const controller = useMemo(() => new ProjectMcpCatalogController(
    jobId ?? '', params => api.projectMcpCatalog(params), owner.isCurrent
  ), [api, jobId, owner])
  const state = useSyncExternalStore(controller.subscribe, controller.snapshot)
  useEffect(() => {
    if (jobId) void controller.load()
    return () => controller.invalidate()
  }, [controller, jobId])
  return { controller, state }
}
