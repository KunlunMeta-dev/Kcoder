import { useEffect, useMemo, useSyncExternalStore } from 'react'
import { MigrationDefinitionSourceDiscovery } from './migrationDefinitionSourceDiscovery'

export function useMigrationDefinitionSourceDiscovery(targetId: string, workspacePath: string | undefined, isCurrent: () => boolean) {
  const controller = useMemo(() => new MigrationDefinitionSourceDiscovery(targetId, workspacePath, isCurrent), [targetId, workspacePath, isCurrent])
  const state = useSyncExternalStore(controller.subscribe, controller.snapshot, controller.snapshot)
  useEffect(() => { controller.activate(); return controller.dispose }, [controller])
  return { ...state, discover: controller.discover, close: controller.close, changePage: controller.changePage,
    select: controller.select, selections: controller.selections }
}
