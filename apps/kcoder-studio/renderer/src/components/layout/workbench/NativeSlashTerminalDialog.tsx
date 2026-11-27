import { lazy, Suspense } from 'react'
import { ModalDialog } from '@/components/ui/modal-dialog'
import { useTranslation } from '@/hooks/useTranslation'
import type { startGatewayKcoderTui } from '@/kcoder/gatewayServiceBridge'

const RemoteTerminal = lazy(() =>
  import('../workspace-panels/RemoteTerminal').then(module => ({ default: module.RemoteTerminal }))
)

export type StartedTerminal = Awaited<ReturnType<typeof startGatewayKcoderTui>>
export type NativeSlashLaunch = {
  owner: string
  name: string
  started?: StartedTerminal
  error?: 'unsupported' | 'busy' | 'failed'
  exited?: boolean
}

export function NativeSlashTerminalDialog({ launch, onClose, onExit }: {
  launch: NativeSlashLaunch
  onClose: () => void
  onExit: (sessionId: string) => void
}) {
  const { t } = useTranslation('common')
  const started = launch.started
  const loading = <p role="status">{t('workbench.slash_native_opening')}</p>
  return (
    <ModalDialog
      title={t('workbench.slash_native_title', { command: launch.name })}
      testId="kcoder-native-slash-terminal"
      wide
      onClose={onClose}
    >
      {launch.error ? (
        <p role="alert">{t(`workbench.slash_native_${launch.error}`)}</p>
      ) : started ? (
        <div className="flex h-[min(60dvh,32rem)] min-h-0 flex-col">
          {launch.exited && <div role="status" className="pb-2 text-sm">{t('workbench.slash_native_exited')}</div>}
          <div className="min-h-0 flex-1">
            <Suspense fallback={loading}>
              <RemoteTerminal
                sessionId={started.session.session_id}
                clientFactory={started.clientFactory}
                cwd={started.session.path}
                active={!launch.exited}
                onExit={() => onExit(started.session.session_id)}
              />
            </Suspense>
          </div>
        </div>
      ) : loading}
    </ModalDialog>
  )
}
