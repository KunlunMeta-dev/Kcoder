import { useEffect, useRef, useState } from 'react'
import { Button } from '@/components/ui/button'
import { useTranslation } from '@/hooks/useTranslation'
import { usePluginTargetScope } from '@/kcoder/usePluginTargetScope'
import { requestLocalExecutor } from '@/host/localExecutor'
import { isIntegrationScope } from '../../../../../shared/generated/contractGuards.mjs'
import type { IntegrationEntityRef } from '../../../../../shared/generated/contracts'
import { OfficeController, OfficeClientError } from '@/features/office-integration/controller'
import {
  ArtifactCollection,
  type OfficeTurnPhase,
} from '@/features/office-integration/ArtifactCollection'
import { OfficeErrorNotice } from '@/features/office-integration/OfficeErrorNotice'
import { readNativeOfficeSettings } from '@/features/runtime-governance/nativeOfficeSettings'
import {
  nativeOfficeTransport,
  type NativeOfficeTarget,
  type NativeOfficeFiles,
  type NativeOfficeDownloadResult,
} from '@/features/runtime-governance/nativeOfficeTransport'
import { fixedTaskArtifacts } from './fixedArtifacts'

export interface TaskArtifactViewerProps {
  target: NativeOfficeTarget
  threadId: string
  references: IntegrationEntityRef[]
  automationRunId?: string
  workflowTaskId?: string
  phase: OfficeTurnPhase
  readExport: NonNullable<NativeOfficeFiles['readExport']>
  onClose: () => void
}
export function TaskArtifactViewer(props: TaskArtifactViewerProps) {
  const scope = usePluginTargetScope(props.target.serverId, props.target.workspacePath)
  const key = JSON.stringify([
    scope.key,
    props.target.serverId,
    props.target.workspacePath,
    props.threadId,
    props.references,
    props.automationRunId,
    props.workflowTaskId,
  ])
  return <ArtifactsSession key={key} {...props} isCurrent={scope.isCurrent} />
}
function ArtifactsSession({
  target,
  threadId,
  references,
  phase,
  readExport,
  automationRunId,
  workflowTaskId,
  onClose,
  isCurrent,
}: TaskArtifactViewerProps & { isCurrent: () => boolean }) {
  const { t } = useTranslation('officeIntegration')
  const [ready, setReady] = useState<{
    controller: OfficeController
    transport: ReturnType<typeof nativeOfficeTransport>
    loadPage: ReturnType<typeof fixedTaskArtifacts>
  }>()
  const [error, setError] = useState<unknown>()
  const [settled, setSettled] = useState(false)
  const [cancelled, setCancelled] = useState(false)
  const [download, setDownload] = useState<NativeOfficeDownloadResult['status'] | 'reading'>()
  const pending = useRef<AbortController | undefined>(undefined)
  useEffect(() => {
    const abort = new AbortController()
    pending.current = abort
    let owned: ReturnType<typeof nativeOfficeTransport> | undefined
    void (async () => {
      const settings = await readNativeOfficeSettings(target, { signal: abort.signal, isCurrent })
      if (!settings.effectiveEnabled || !settings.connectionEnabled || settings.restartRequired)
        throw new OfficeClientError('OFFICE_EXPORT_PROVIDER_UNAVAILABLE', 'repair_configuration')
      const scope = await requestLocalExecutor<unknown>(
        'runtime.integrations.request',
        { ...target, method: 'integrations/scope/read', params: {} },
        { signal: abort.signal }
      )
      if (abort.signal.aborted || !isCurrent()) return
      if (!isIntegrationScope(scope))
        throw new OfficeClientError('OFFICE_SCOPE_CHANGED', 'retry_read')
      owned = nativeOfficeTransport(target, scope, isCurrent, { readExport, automationRunId })
      const controller = new OfficeController(owned, () => scope)
      if (workflowTaskId && !automationRunId)
        throw new OfficeClientError('OFFICE_INVALID_REQUEST', 'retry_read')
      const loadPage = fixedTaskArtifacts(controller, threadId, references, scope,
        workflowTaskId && automationRunId ? { runId: automationRunId, workflowTaskId } : undefined)
      if (!abort.signal.aborted && owned.isCurrent())
        setReady({ controller, transport: owned, loadPage })
    })()
      .catch(value => {
        if (!abort.signal.aborted && isCurrent()) setError(value)
      })
      .finally(() => {
        if (!abort.signal.aborted && isCurrent()) setSettled(true)
      })
    return () => {
      abort.abort()
      owned?.dispose()
    }
  }, [target, threadId, references, readExport, automationRunId, workflowTaskId, isCurrent])
  const exportReady = (receipt: unknown) => {
    if (!ready?.transport.isCurrent() || !ready.transport.readExport) return
    const owner = ready
    const run = ready.transport.readExport
    setDownload('reading')
    void run(receipt)
      .then(result => {
        if (owner.transport.isCurrent() && result) {
          setDownload(result.status)
          if (result.acknowledgement === 'unconfirmed')
            setError(new OfficeClientError('OFFICE_EXPORT_UNCONFIRMED', 'reconcile_original'))
        }
      })
      .catch(value => {
        if (owner.transport.isCurrent()) {
          if (value instanceof OfficeClientError && value.code === 'OFFICE_CANCELLED') {
            setDownload('cancelled')
            return
          }
          setDownload(undefined)
          setError(value)
        }
      })
  }
  return (
    <section className="space-y-5 p-5" data-testid="task-artifact-viewer">
      <div className="flex flex-wrap gap-2">
        <Button variant="ghost" onClick={onClose}>
          {t('back')}
        </Button>
        <Button
          variant="ghost"
          onClick={() => {
            pending.current?.abort()
            ready?.transport.cancelPending()
            if (!ready) {
              setError(undefined)
              setCancelled(true)
              setSettled(true)
            }
          }}
        >
          {t('cancel')}
        </Button>
      </div>
      {error ? <OfficeErrorNotice error={error} onClose={() => setError(undefined)} /> : null}
      {download && (
        <p
          role="status"
          data-testid="task-artifact-download-status"
          data-status={download}
          className="text-sm text-text-secondary"
        >
          {t(`exportStatuses.${download}`)}
        </p>
      )}
      {ready ? (
        <ArtifactCollection
          controller={ready.controller}
          threadId={threadId}
          phase={phase}
          loadPage={ready.loadPage}
          onExportReady={exportReady}
        />
      ) : !settled ? (
        <p role="status" className="text-sm text-text-secondary">
          {t('nativeLoading')}
        </p>
      ) : (
        <p role="status" className="text-sm text-text-secondary">
          {t(cancelled ? 'nativeCancelled' : 'nativeUnavailable')}
        </p>
      )}
    </section>
  )
}
