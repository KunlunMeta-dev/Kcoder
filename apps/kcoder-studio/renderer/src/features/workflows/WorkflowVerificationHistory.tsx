import { useState } from 'react'
import { Button } from '@/components/ui/button'
import { ModalDialog } from '@/components/ui/modal-dialog'
import { useTranslation } from '@/hooks/useTranslation'

export interface WorkflowVersionReferenceView {
  definitionId: string
  version: number
  definitionSha256: string
  availability: string
  latest: boolean
  currentRevision: number | null
  pinCount: number
  pins: Array<{ definitionId: string; version: number | null; nodeId: string; source: string }>
  runReferenceCount: number
  runs: Array<{
    runId: string
    definitionId: string
    version: number
    state: 'active' | 'unknown' | 'terminal_known'
    resumeCount: number
  }>
  canArchive: boolean
}
export function WorkflowVerificationHistory({
  definitionId,
  version,
  references,
  loading = false,
  disabled = false,
  error,
  isCurrent,
  onInspect,
  onArchive,
}: {
  definitionId: string
  version: number | null
  references?: WorkflowVersionReferenceView | null
  loading?: boolean
  disabled?: boolean
  error?: string
  isCurrent: () => boolean
  onInspect: (version: number) => void
  onArchive: (version: number, expectedRevision: number) => Promise<void>
}) {
  const { t } = useTranslation('common')
  const [confirmation, setConfirmation] = useState<WorkflowVersionReferenceView | null>(null)
  const [pending, setPending] = useState(false)
  const [failure, setFailure] = useState('')
  const current =
    references?.definitionId === definitionId && references.version === version ? references : null
  const eligible =
    current?.canArchive &&
    current.availability === 'saved' &&
    !current.latest &&
    current.pinCount === 0 &&
    current.currentRevision !== null &&
    current.runs.every(run => run.state === 'terminal_known')
  const archive = async () => {
    if (
      !confirmation ||
      disabled ||
      pending ||
      !isCurrent() ||
      confirmation.definitionId !== definitionId ||
      confirmation.version !== version
    )
      return
    setPending(true)
    setFailure('')
    try {
      await onArchive(confirmation.version, confirmation.currentRevision!)
      if (isCurrent()) setConfirmation(null)
    } catch (error) {
      if (isCurrent()) setFailure(String(error))
    } finally {
      if (isCurrent()) setPending(false)
    }
  }
  return (
    <section className="space-y-2 text-sm" data-testid="workflow-version-references">
      <div className="flex flex-wrap items-center gap-2">
        <Button
          type="button"
          size="sm"
          variant="ghost"
          className="max-md:min-h-11"
          disabled={disabled || loading || pending || version === null}
          onClick={() => {
            if (version !== null) onInspect(version)
          }}
          data-testid="workflow-inspect-version-references"
        >
          {t('workflowVerification.references')}
        </Button>
        {eligible && (
          <Button
            type="button"
            size="sm"
            variant="ghost"
            className="max-md:min-h-11"
            disabled={disabled || loading || pending}
            data-testid="workflow-archive-version"
            onClick={() => {
              setFailure('')
              setConfirmation(current)
            }}
          >
            {t('workflowVerification.archive')}
          </Button>
        )}
      </div>
      {error && <p role="alert">{error}</p>}
      {current && (
        <>
          <p>
            {t('workflowVerification.referenceCount', {
              count: current.pinCount,
              runs: current.runReferenceCount,
            })}
          </p>
          {current.latest && <p>{t('workflowVerification.latestProtected')}</p>}
          {current.availability === 'archived_history' && (
            <p>{t('workflowVerification.historicalSnapshot')}</p>
          )}
          {current.pins.map(pin => (
            <p key={`${pin.definitionId}:${pin.version}:${pin.nodeId}:${pin.source}`}>
              {t('workflowVerification.versionPin', {
                id: pin.definitionId,
                version: pin.version ?? '—',
                node: pin.nodeId,
                source: pin.source,
              })}
            </p>
          ))}
          {current.runs.map(run => (
            <p key={run.runId}>
              {t('workflowVerification.runReference', { id: run.runId, state: run.state })}
            </p>
          ))}
        </>
      )}
      {confirmation && (
        <ModalDialog
          title={t('workflowVerification.archive')}
          testId="workflow-archive-dialog"
          pending={pending}
          onClose={() => setConfirmation(null)}
          closeLabel={t('workflowVerification.cancel')}
        >
          <p className="my-4 text-sm">
            {t('workflowVerification.archiveConfirmation', { version: confirmation.version })}
          </p>
          <p className="my-4 break-all text-code">{confirmation.definitionSha256}</p>
          {failure && (
            <p role="alert" className="my-3">
              {failure}
            </p>
          )}
          <div className="flex justify-end gap-2">
            <Button
              type="button"
              variant="ghost"
              disabled={pending}
              onClick={() => setConfirmation(null)}
            >
              {t('workflowVerification.cancel')}
            </Button>
            <Button
              type="button"
              disabled={
                disabled ||
                pending ||
                !isCurrent() ||
                confirmation.definitionId !== definitionId ||
                confirmation.version !== version
              }
              data-testid="workflow-archive-confirm"
              onClick={() => void archive()}
            >
              {t('workflowVerification.archive')}
            </Button>
          </div>
        </ModalDialog>
      )}
    </section>
  )
}
