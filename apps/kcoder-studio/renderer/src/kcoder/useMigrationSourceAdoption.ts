import { useEffect, useMemo, useSyncExternalStore } from 'react'
import { MigrationSourceAdoptionController } from './migrationSourceAdoptionController'
import type { GatewayServer } from './gatewayRpc'
import type { MigrationSourceReceipt } from '../../../shared/generated/contracts'

export function useMigrationSourceAdoption(target: GatewayServer, receipt: MigrationSourceReceipt, isCurrent: () => boolean) {
  const { requestId, manifestSha256, bytes, entries } = receipt
  const controller = useMemo(() => new MigrationSourceAdoptionController({ target, receipt: { requestId, manifestSha256, bytes, entries }, isCurrent }), [target, requestId, manifestSha256, bytes, entries, isCurrent])
  const state = useSyncExternalStore(controller.subscribe, controller.snapshot, controller.snapshot)
  useEffect(() => { controller.activate(); return controller.dispose }, [controller])
  return { ...state, load: controller.load, select: controller.select, map: controller.map, mapInstructions: controller.mapInstructions, prepare: controller.prepare,
    read: controller.read, operate: controller.operate, canPrepare: controller.canPrepare() }
}
