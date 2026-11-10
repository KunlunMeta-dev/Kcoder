import { useEffect, useMemo, useSyncExternalStore } from 'react'
import { InstructionSourcesController } from '../../../shared/migrationInstructionSources'
import { createMigrationSourceSessionClient } from './gatewayMigrationSourceSessions'
import { createRandomUuid } from '@/lib/random-id'
import { captureAccountContextRevision } from './accountContextEvents'

export function useMigrationInstructionSources(targetId: string, isCurrent: () => boolean) {
  const controller = useMemo(() => {
    const id = createRandomUuid(), account = captureAccountContextRevision()
    const current = () => isCurrent() && account(targetId)
    return new InstructionSourcesController({ targetId, isCurrent: current, newId: createRandomUuid,
      api: createMigrationSourceSessionClient({ captureScope: () => current() ? id : '' }),
      cleanup: createMigrationSourceSessionClient({ captureScope: () => account(targetId) ? id : '' }),
    })
  }, [targetId, isCurrent])
  const state = useSyncExternalStore(controller.subscribe, controller.snapshot, controller.snapshot)
  useEffect(() => { controller.activate(); return controller.dispose }, [controller])
  return { ...state, captureSource: controller.capture, observe: controller.observe, changePage: controller.page,
    preview: controller.preview, close: controller.close }
}
