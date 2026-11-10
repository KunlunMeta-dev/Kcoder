import { useState, type FormEvent } from 'react'
import { Button } from '@/components/ui/button'
import { ModalDialog } from '@/components/ui/modal-dialog'
import { useTranslation } from '@/hooks/useTranslation'
import { signInKCoderAccount, signOutKCoderAccount, type KCoderAccountStatus } from '@/kcoder/mobilePairing'

export function KCoderAccountDialog({ signOut, portalUrl, onClose, onDone }: {
  signOut: boolean
  portalUrl?: string
  onClose: () => void
  onDone: (status: KCoderAccountStatus) => void
}) {
  const { t } = useTranslation('common')
  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')
  const [pending, setPending] = useState(false)
  const [error, setError] = useState('')
  const [revocationUnconfirmed, setRevocationUnconfirmed] = useState(false)
  const [relayRegistrationFailed, setRelayRegistrationFailed] = useState(false)
  const title = t(signOut ? 'workbench.kcoder_account_logout' : 'workbench.kcoder_account_login')

  async function submit(event: FormEvent) {
    event.preventDefault()
    if (pending || (!signOut && !portalUrl)) return
    setPending(true)
    setError('')
    try {
      const status = await (signOut ? signOutKCoderAccount() : signInKCoderAccount(portalUrl!, username.trim(), password))
      setRevocationUnconfirmed(Boolean(status.revocationUnconfirmed))
      setRelayRegistrationFailed(Boolean(status.relayRegistrationFailed))
      onDone(status)
    } catch (cause) {
      const code = (cause as { code?: string })?.code
      if (code === 'KCODER_ACCOUNT_PASSWORD_RESET_REQUIRED') {
        setError(t('workbench.kcoder_account_password_reset_required'))
        return
      }
      const key = code === 'KCODER_ACCOUNT_CREDENTIALS_REJECTED'
        ? 'workbench.kcoder_account_credentials_invalid'
        : code === 'KCODER_ACCOUNT_SECURE_ORIGIN_REQUIRED'
          ? 'workbench.mobile_connection_relay_secure_origin'
          : code === 'KCODER_ACCOUNT_RATE_LIMITED'
            ? 'workbench.mobile_connection_relay_login_limited'
            : code === 'KCODER_ACCOUNT_ALREADY_SIGNED_IN'
              ? 'workbench.kcoder_account_already_signed_in'
              : 'workbench.kcoder_account_unavailable'
      setError(t(key))
    } finally { setPending(false) }
  }

  return (
    <ModalDialog title={title} testId="kcoder-account-dialog" pending={pending} onClose={onClose}
      closeLabel={t('workbench.cancel', '取消')}>
      {revocationUnconfirmed ? (
        <p role="status" className="mt-4 text-sm text-text-secondary">{t('workbench.kcoder_account_revocation_unconfirmed')}</p>
      ) : relayRegistrationFailed ? (
        <p role="status" className="mt-4 text-sm text-text-secondary">{t('workbench.kcoder_account_relay_registration_failed')}</p>
      ) : <form className="mt-4 space-y-3" onSubmit={event => void submit(event)}>
        <p className="text-sm text-text-secondary">
          {t(signOut ? 'workbench.kcoder_account_logout_note' : 'workbench.kcoder_account_purpose')}
        </p>
        {!signOut && portalUrl && (
          <p><a href={portalUrl} target="_blank" rel="noopener noreferrer" className="text-sm text-primary underline">
            {t('workbench.kcoder_account_portal')}
          </a></p>
        )}
        {!signOut && (
          <>
            <label className="block text-sm">
              {t('workbench.kcoder_account_username')}
              <input className="mt-1 block h-9 w-full rounded-lg border border-border bg-background px-3 text-sm"
                name="username" value={username} onChange={event => setUsername(event.target.value)}
                required disabled={pending} autoComplete="username" spellCheck={false} maxLength={64} />
            </label>
            <label className="block text-sm">
              {t('workbench.kcoder_account_password')}
              <input className="mt-1 block h-9 w-full rounded-lg border border-border bg-background px-3 text-sm"
                name="password" type="password" value={password} onChange={event => setPassword(event.target.value)}
                required disabled={pending} autoComplete="current-password" maxLength={256} />
            </label>
          </>
        )}
        {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
        <div className="flex justify-end gap-2">
          <Button type="button" variant="outline" disabled={pending} onClick={onClose}>{t('workbench.cancel', '取消')}</Button>
          <Button type="submit" disabled={pending || (!signOut && (!portalUrl || !username.trim() || !password))}>
            {pending ? t('workbench.kcoder_account_pending') : title}
          </Button>
        </div>
      </form>}
    </ModalDialog>
  )
}
