import { useEffect, useLayoutEffect, useMemo, useSyncExternalStore } from 'react'
import type { MigrationSourceKind } from '../../../shared/generated/contracts'
import type { createMigrationApi } from './gatewayMigration'
import { MigrationBatchHistoryDiscovery } from './migrationBatchHistoryDiscovery'

/** Source/target changes create a fresh owner before an old catalog can render. */
export function useMigrationBatchHistorySources(api: ReturnType<typeof createMigrationApi>, kind: MigrationSourceKind, valid: () => boolean) {
  const owner = useMemo(() => new MigrationBatchHistoryDiscovery(api, kind), [api, kind])
  useLayoutEffect(() => { owner.current(valid) }, [owner, valid])
  useEffect(() => { owner.activate(); return owner.dispose }, [owner])
  const state = useSyncExternalStore(owner.subscribe, owner.snapshot, owner.snapshot)
  return { ...state, kind, reset: owner.reset, discover: owner.discover, discoverFamilies: owner.discoverFamilies,
    paginate: owner.paginate, checked: owner.checked, toggle: owner.toggle }
}
