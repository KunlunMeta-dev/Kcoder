import { useEffect, useRef, useState } from 'react'
import { Button } from '@/components/ui/button'
import { ModalDialog } from '@/components/ui/modal-dialog'
import { useTranslation } from '@/hooks/useTranslation'
import { listenAccountContextChanges } from '@/kcoder/accountContextEvents'
import { RemoteOperationClient, RemoteOperationClientError, type RemoteOperationTarget } from '@/kcoder/remotes/operationClient'
import type { RemoteOperationSnapshot, RemoteOperationSummary } from '../../../../shared/generated/contracts.integrations-remotes'

export function NativeRemoteOperationPanel({ target, createClient = value => new RemoteOperationClient(value) }: {
  target: RemoteOperationTarget
  createClient?: (target: RemoteOperationTarget) => Pick<RemoteOperationClient, 'read' | 'recent' | 'cancel' | 'dispose'>
}) {
  const { t } = useTranslation('remoteCapabilities')
  const [operationId, setOperationId] = useState('')
  const [snapshot, setSnapshot] = useState<RemoteOperationSnapshot>()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string>()
  const [uncertain, setUncertain] = useState(false)
  const [notFound, setNotFound] = useState(false)
  const [confirm, setConfirm] = useState(false)
  const [recent, setRecent] = useState<RemoteOperationSummary[]>([])
  const key = JSON.stringify([target.serverId, target.workspacePath])
  const owner = useRef({ generation: 0, alive: true, client: undefined as ReturnType<typeof createClient> | undefined })
  useEffect(() => {
    const current = owner.current
    current.alive = true
    const clear = () => {
      current.generation++; current.client?.dispose(); current.client = undefined
      setOperationId('')
      setSnapshot(undefined); setError(undefined); setBusy(false); setConfirm(false); setUncertain(false); setNotFound(false); setRecent([])
    }
    clear()
    const stop = listenAccountContextChanges(clear)
    return () => { current.alive = false; current.generation++; current.client?.dispose(); stop() }
  }, [key])
  const run = async (cancellation: boolean, selectedId = operationId) => {
    const current = owner.current
    const generation = ++current.generation
    const original = snapshot
    if (!cancellation) { current.client?.dispose(); current.client = createClient(target) }
    const client = current.client
    if (!client || (cancellation && !original)) return
    setBusy(true); setError(undefined); setNotFound(false); setConfirm(false)
    try {
      const reply = cancellation ? await client.cancel(original!.operationId, original!.operationRevision) : await client.read(selectedId.trim())
      if (!current.alive || current.generation !== generation) return
      setSnapshot(reply.snapshot ?? undefined); setNotFound(reply.snapshot === null); setUncertain(false)
    } catch (failure) {
      if (!current.alive || current.generation !== generation) return
      setUncertain(failure instanceof RemoteOperationClientError && failure.uncertain)
      setError(failure instanceof RemoteOperationClientError && failure.code === 'REMOTE_CONTROL_UPGRADE_REQUIRED' ? 'upgrade'
        : failure instanceof RemoteOperationClientError && failure.code === 'REMOTE_CONTROL_OWNER_CHANGED' ? 'ownerChanged' : 'unavailable')
    } finally { if (current.alive && current.generation === generation) setBusy(false) }
  }
  const readRecent = async () => {
    const current = owner.current; const generation = ++current.generation
    current.client?.dispose(); current.client = createClient(target); const client = current.client
    setBusy(true); setError(undefined)
    try {
      const reply = await client.recent()
      if (current.alive && current.generation === generation) setRecent(reply.items)
    } catch { if (current.alive && current.generation === generation) setError('unavailable') }
    finally { if (current.alive && current.generation === generation) setBusy(false) }
  }
  const canCancel = snapshot && !snapshot.receiver.terminalConfirmed && snapshot.cleanup !== 'confirmed'
    && !['cancel_requested', 'cancelled', 'completed', 'rejected'].includes(snapshot.operationPhase)
    && snapshot.operationId === operationId.trim() && !uncertain && !busy
  return <section className="min-w-0 space-y-3 border-t border-border pt-5" data-testid="native-remote-operation">
    <div className="space-y-1"><h2 className="text-base font-semibold">{t('operation.title')}</h2><p className="text-sm text-text-secondary">{t('operation.description')}</p></div>
    <Button type="button" variant="ghost" disabled={busy} onClick={() => void readRecent()} className="max-md:min-h-11">{t('operation.recent')}</Button>
    {recent.length > 0 && <div className="min-w-0 space-y-1" data-testid="remote-operation-recent">{recent.map(row => <Button key={row.operationId} type="button" variant="ghost" disabled={busy} data-remote-operation-id={row.operationId}
      className="flex min-h-11 w-full min-w-0 justify-start gap-2" onClick={() => { setOperationId(row.operationId); setSnapshot(undefined); void run(false, row.operationId) }}>
      <span className="min-w-0 truncate font-mono text-sm">{row.operationId}</span><span className="shrink-0 text-xs text-text-muted">{t(row.receiverObserved ? 'operation.receiverLinked' : 'operation.receiverNotObserved')}</span>
    </Button>)}</div>}
    <form className="flex min-w-0 flex-wrap items-end gap-2" onSubmit={event => { event.preventDefault(); void run(false) }}>
      <label className="min-w-0 flex-1 space-y-2 text-sm"><span className="block">{t('operation.id')}</span><input value={operationId} onChange={event => { setOperationId(event.target.value); setSnapshot(undefined); setUncertain(false) }} disabled={busy} maxLength={256}
        className="block min-h-11 w-full rounded-md border border-border bg-surface px-3 py-2 text-base text-text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus" data-testid="remote-operation-id" /></label>
      <Button type="submit" variant="outline" disabled={busy || !operationId.trim()} className="max-md:min-h-11">{busy ? t('operation.reading') : t('operation.read')}</Button>
    </form>
    {error && <p role="status" className="text-sm text-text-secondary">{t(`operation.errors.${error}`)}</p>}
    {uncertain && <p role="status" className="text-sm text-warning">{t('operation.unknownCancellation')}</p>}
    {notFound && <p role="status" className="text-sm text-text-secondary">{t('operation.notFound')}</p>}
    {snapshot && <div className="min-w-0 space-y-3" data-testid="remote-operation-observation">
      <dl className="grid min-w-0 grid-cols-1 gap-2 text-sm sm:grid-cols-2">
        <div><dt className="text-text-muted">{t('operation.task')}</dt><dd>{t(`operation.status.${snapshot.receiver.status}`)}</dd></div>
        <div><dt className="text-text-muted">{t('operation.cleanup')}</dt><dd>{t(`operation.cleanupStatus.${snapshot.cleanup}`)}</dd></div>
      </dl>
      <p className="text-sm text-text-secondary">{t('operation.businessPartial')}</p>
      {snapshot.artifact && <p className="break-all text-sm">{t('operation.artifact')}: {snapshot.artifact.id} · {snapshot.artifact.bytes.toLocaleString()} B</p>}
      <div className="flex flex-wrap gap-2"><Button type="button" variant="outline" disabled={!canCancel} onClick={() => setConfirm(true)} className="max-md:min-h-11">{t('operation.cancel')}</Button></div>
      <details className="text-sm text-text-secondary"><summary className="cursor-pointer">{t('operation.details')}</summary><dl className="mt-2 min-w-0 space-y-2">
        <div><dt>{t('operation.id')}</dt><dd className="break-all font-mono">{snapshot.operationId}</dd></div>
        {snapshot.receiver.identity && <div><dt>{t('operation.receiver')}</dt><dd className="break-all font-mono">{snapshot.receiver.identity.threadId} / {snapshot.receiver.identity.turnId}</dd></div>}
        <div><dt>{t('operation.protocol')}</dt><dd className="break-all">{snapshot.protocol.map(stage => `${stage.stage}: ${stage.status}`).join(' · ')}</dd></div>
        {snapshot.artifact && <div><dt>SHA-256</dt><dd className="break-all font-mono">{snapshot.artifact.sha256}</dd></div>}
      </dl></details>
    </div>}
    {confirm && <ModalDialog title={t('operation.cancelTitle')} testId="remote-operation-cancel-confirm" closeLabel={t('operation.back')} onClose={() => setConfirm(false)}>
      <p className="my-4 break-words text-sm text-text-secondary">{t('operation.cancelDescription')}</p>
      <p className="mb-4 break-all font-mono text-sm">{snapshot?.operationId}</p>
      <div className="flex flex-wrap justify-end gap-2"><Button variant="ghost" onClick={() => setConfirm(false)}>{t('operation.back')}</Button><Button variant="destructive" onClick={() => void run(true)}>{t('operation.confirmCancel')}</Button></div>
    </ModalDialog>}
  </section>
}
