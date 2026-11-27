import { useEffect, useRef, useState } from 'react'
import { Folder, ShieldCheck } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { ModalDialog } from '@/components/ui/modal-dialog'
import { useTranslation } from '@/hooks/useTranslation'
import type { GatewayServer } from '@/kcoder/gatewayRpc'
import {
  PeerSshEnrollmentError,
  peerSshEnrollmentRequest,
  type PeerSshProposal,
  type PeerSshStatus,
} from '@/kcoder/peerSshEnrollment'
import { InputWithIcon } from './settings-ui'
import { StableLabel } from '@/components/ui/stable-content'

type Action = 'status' | 'prepare' | 'apply' | 'reconcile' | 'revoke' | 'discard'

export function PeerSshEnrollment({ server }: { server: GatewayServer }) {
  const { t } = useTranslation('localRuntime')
  const [open, setOpen] = useState(false)
  const [workspace, setWorkspace] = useState(server.workspacePath ?? '')
  const [busy, setBusy] = useState<Action | null>(null)
  const [current, setCurrent] = useState<PeerSshStatus | null>(null)
  const [preview, setPreview] = useState<PeerSshProposal | null>(null)
  const [confirmRevoke, setConfirmRevoke] = useState(false)
  const [notice, setNotice] = useState<'recorded' | 'unknown' | null>(null)
  const [error, setError] = useState<string | null>(null)
  const active = useRef(true)
  const busyRef = useRef(false)
  const revision = useRef(0)

  useEffect(() => {
    active.current = true
    return () => { active.current = false }
  }, [])

  const close = () => {
    revision.current++
    setOpen(false)
    setCurrent(null)
    setPreview(null)
    setConfirmRevoke(false)
    setNotice(null)
    setError(null)
  }

  const run = async (action: Action, original?: PeerSshProposal) => {
    if (busyRef.current || !workspace) return
    busyRef.current = true
    const requestRevision = revision.current
    setBusy(action)
    setError(null)
    setNotice(null)
    try {
      const result = await peerSshEnrollmentRequest(action, server.id, workspace,
        original && { proposalId: original.proposalId, digest: original.digest })
      if (!active.current || requestRevision !== revision.current) return
      if (action === 'status' && 'proposals' in result) {
        setCurrent(result)
        setPreview(null)
      } else if (action === 'prepare' && 'proposalId' in result) {
        setCurrent(previous => previous
          ? { ...previous, proposals: [...previous.proposals, result] } : null)
        setPreview(result)
      } else {
        // A completed receipt is historical. Read current state before claiming
        // that a pin still exists or enabling another administrative action.
        setCurrent(null)
        setPreview(null)
        setConfirmRevoke(false)
        setNotice('recorded')
      }
    } catch (cause) {
      if (!active.current || requestRevision !== revision.current) return
      setCurrent(null)
      setPreview(null)
      setConfirmRevoke(false)
      if (cause instanceof PeerSshEnrollmentError && cause.outcomeUnknown) setNotice('unknown')
      else setError(cause instanceof PeerSshEnrollmentError ? cause.code : 'PEER_SSH_REQUEST_FAILED')
    } finally {
      busyRef.current = false
      if (active.current && requestRevision === revision.current) setBusy(null)
    }
  }

  const pending = current?.proposals.filter(item =>
    item.phase === 'proposed' || item.phase === 'dispatching' || item.phase === 'setup_unconfirmed') ?? []
  const canChange = current !== null && pending.length === 0 &&
    current.pinStatus !== 'revoking' && current.pinStatus !== 'setup_unconfirmed'
  const errorKey = error === 'PEER_SSH_FULL_BROWSER_LOGIN_REQUIRED'
    ? 'loginRequired'
    : error === 'PEER_SSH_PIN_IDENTITY_CHANGED'
      ? 'identityChanged'
      : error === 'PEER_SSH_PIN_NATIVE_REVISION_CHANGED'
        ? 'revisionChanged'
        : error === 'PEER_SSH_UNSUPPORTED' || error === 'PEER_SSH_ADMIN_HOST_UNSUPPORTED' ||
            error === 'PEER_SSH_ENROLLMENT_TARGET_UNSUPPORTED'
          ? 'unsupported'
          : error === 'PEER_SSH_ENROLLMENT_SCOPE_CHANGED' || error === 'PEER_SSH_PROPOSAL_CHANGED'
            ? 'scopeChanged' : 'failed'

  return (
    <>
      <Button type="button" variant="ghost" size="sm" data-testid={`peer-ssh-open-${server.id}`}
        className="mt-1 max-md:min-h-11" onClick={() => setOpen(true)}>
        <ShieldCheck className="h-4 w-4" aria-hidden="true" />
        {t('peerSsh.open')}
      </Button>
      {open && (
        <ModalDialog title={t('peerSsh.title', { name: server.label })} testId="peer-ssh-dialog"
          closeLabel={t('peerSsh.close')} pending={busy !== null} onClose={close}>
          <p className="mt-3 text-sm text-text-secondary">{t('peerSsh.description')}</p>
          <label className="mt-4 block text-sm font-medium" htmlFor="peer-ssh-workspace">
            {t('peerSsh.workspace')}
          </label>
          <InputWithIcon id="peer-ssh-workspace" data-testid="peer-ssh-workspace" icon={<Folder className="h-4 w-4" />}
            value={workspace} disabled={busy !== null} aria-describedby="peer-ssh-workspace-help"
            onChange={event => {
              revision.current++
              setWorkspace(event.target.value)
              setCurrent(null); setPreview(null); setConfirmRevoke(false); setNotice(null); setError(null)
            }} />
          <p id="peer-ssh-workspace-help" className="mt-1 text-xs text-text-secondary">{t('peerSsh.workspaceHelp')}</p>
          <Button type="button" variant="secondary" size="sm" data-testid="peer-ssh-read"
            className="mt-3 max-md:min-h-11" disabled={busy !== null || !workspace}
            onClick={() => void run('status')}>
            <StableLabel alternatives={[t('peerSsh.reading'), t('peerSsh.read')]}>{busy === 'status' ? t('peerSsh.reading') : t('peerSsh.read')}</StableLabel>
          </Button>

          {error && <p role="alert" className="mt-3 text-sm text-red-500">{t(`peerSsh.errors.${errorKey}`)}</p>}
          {notice && <p role={notice === 'unknown' ? 'alert' : 'status'} className="mt-3 text-sm text-text-secondary">
            {t(`peerSsh.${notice}`)}
          </p>}
          {current && (
            <div className="mt-4 space-y-3" aria-live="polite">
              <p data-testid="peer-ssh-current-status" className="text-sm font-medium">
                {t(`peerSsh.status.${current.pinStatus}`)}
              </p>
              <p className="text-xs text-text-secondary">{t('peerSsh.statusHelp')}</p>
              {pending.filter(item => item.proposalId !== preview?.proposalId).map(item => (
                <div key={item.proposalId} className="rounded-lg border border-border p-3 text-sm">
                  <p>{t('peerSsh.pending', { action: t(`peerSsh.action.${item.action}`) })}</p>
                  <Button type="button" variant="secondary" size="sm" className="mt-2 max-md:min-h-11"
                    data-testid={`peer-ssh-reconcile-${item.proposalId}`} disabled={busy !== null}
                    onClick={() => void run('reconcile', item)}>{t('peerSsh.reconcile')}</Button>
                  {item.phase === 'proposed' && (
                    <Button type="button" variant="secondary" size="sm" className="ml-2 mt-2 max-md:min-h-11"
                      data-testid={`peer-ssh-discard-${item.proposalId}`} disabled={busy !== null}
                      onClick={() => void run('discard', item)}>{t('peerSsh.discard')}</Button>
                  )}
                  {item.phase === 'proposed' && <p className="mt-2 text-xs text-text-secondary">{t('peerSsh.discardHelp')}</p>}
                </div>
              ))}
              {canChange && current.pinStatus !== 'pinned' && !preview && (
                <Button type="button" variant="secondary" size="sm" className="max-md:min-h-11"
                  data-testid="peer-ssh-prepare" disabled={busy !== null}
                  onClick={() => void run('prepare')}>
                  <StableLabel alternatives={[t('peerSsh.preparing'), t('peerSsh.prepare')]}>{busy === 'prepare' ? t('peerSsh.preparing') : t('peerSsh.prepare')}</StableLabel>
                </Button>
              )}
              {canChange && current.pinStatus === 'pinned' && !confirmRevoke && (
                <Button type="button" variant="secondary" size="sm" className="max-md:min-h-11"
                  data-testid="peer-ssh-revoke" disabled={busy !== null}
                  onClick={() => setConfirmRevoke(true)}>{t('peerSsh.revoke')}</Button>
              )}
              {canChange && confirmRevoke && (
                <div className="rounded-lg border border-border p-3">
                  <p className="text-sm">{t('peerSsh.revokeDescription')}</p>
                  <div className="mt-3 flex flex-wrap gap-2">
                    <Button type="button" variant="secondary" size="sm" className="max-md:min-h-11"
                      data-testid="peer-ssh-revoke-cancel" disabled={busy !== null}
                      onClick={() => setConfirmRevoke(false)}>{t('peerSsh.cancel')}</Button>
                    <Button type="button" variant="destructive" size="sm" className="max-md:min-h-11"
                      data-testid="peer-ssh-revoke-confirm" disabled={busy !== null}
                      onClick={() => void run('revoke')}>{t('peerSsh.revokeConfirm')}</Button>
                  </div>
                </div>
              )}
            </div>
          )}
          {preview && (
            <div className="mt-4 space-y-3 rounded-lg border border-border p-3">
              <p className="text-sm font-medium">{t('peerSsh.reviewTitle')}</p>
              <p className="text-xs text-text-secondary">{t('peerSsh.reviewHelp')}</p>
              <dl className="space-y-2 break-all text-xs">
                <div><dt className="text-text-muted">{t('peerSsh.hostKey')}</dt><dd data-testid="peer-ssh-preview-host-key">{preview.enrollment.target.sshHostKey}</dd></div>
                <div><dt className="text-text-muted">{t('peerSsh.sshUser')}</dt><dd data-testid="peer-ssh-preview-user">{preview.enrollment.target.sshUser}</dd></div>
                <div><dt className="text-text-muted">{t('peerSsh.osUser')}</dt><dd data-testid="peer-ssh-preview-uid">{preview.enrollment.native.accountUid}</dd></div>
                <div><dt className="text-text-muted">{t('peerSsh.profile')}</dt><dd>{preview.enrollment.native.profileIdentity}</dd></div>
                <div><dt className="text-text-muted">{t('peerSsh.workspaceIdentity')}</dt><dd>{preview.enrollment.native.workspaceId}</dd></div>
              </dl>
              <div className="flex flex-wrap gap-2">
                <Button type="button" variant="secondary" size="sm" className="max-md:min-h-11"
                  data-testid="peer-ssh-preview-cancel" disabled={busy !== null}
                  onClick={() => setPreview(null)}>{t('peerSsh.cancel')}</Button>
                <Button type="button" variant="primary" size="sm" className="max-md:min-h-11"
                  data-testid="peer-ssh-apply" disabled={busy !== null}
                  onClick={() => void run('apply', preview)}>{t('peerSsh.authorize')}</Button>
              </div>
            </div>
          )}
        </ModalDialog>
      )}
    </>
  )
}
