import { useEffect, useMemo, useSyncExternalStore } from 'react'
import { MigrationHistorySourceDiscovery } from './migrationHistorySourceDiscovery'

export function useMigrationHistorySourceDiscovery(targetId: string, workspacePath: string | undefined, isCurrent: () => boolean) {
  const controller = useMemo(() => new MigrationHistorySourceDiscovery(targetId, workspacePath, isCurrent), [targetId, workspacePath, isCurrent])
  const state = useSyncExternalStore(controller.subscribe, controller.snapshot, controller.snapshot)
  useEffect(() => { controller.activate(); return controller.dispose }, [controller])
  return { ...state, discover: controller.discover, close: controller.close, changePage: controller.page,
    select: controller.select, selections: controller.selections }
}
