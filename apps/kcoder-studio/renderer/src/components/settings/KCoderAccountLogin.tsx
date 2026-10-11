import { Checkbox } from '@/components/ui/checkbox'
import { useEffect, useRef, useState } from 'react'
import { useTranslation } from '@/hooks/useTranslation'
import {
  autoLoginGatewayAccount,
  getAccountDeviceId,
  loginGatewayAccount,
  logoutGatewayAccount,
  type GatewayServer,
} from '@/kcoder/gatewayRpc'
import { Button } from '@/components/ui/button'

import { listenAccountContextChanges } from '@/kcoder/accountContextEvents'

export function KCoderAccountLogin({
  server,
  onChanged,
}: {
  server: GatewayServer
  onChanged: () => Promise<void>
}) {
  const { t } = useTranslation('localRuntime')
  const authenticated = Boolean(server.accountIdentity)
  const hintUsername = server.security?.identity.username ?? server.accountIdentity?.username ?? ''
  const [username, setUsername] = useState(hintUsername)
  const [password, setPassword] = useState('')
  const [remember, setRemember] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [confirmAction, setConfirmAction] = useState<'logout' | 'switch' | null>(null)
  const autoLoginAttempted = useRef(false)
  const usernameInputRef = useRef<HTMLInputElement>(null)

  // Auto-restore a remembered login exactly once per mount. The server
  // re-verifies the saved credential; a logout always cleared it, so an
  // explicit logout is never silently undone here.
  useEffect(() => {
    if (authenticated || autoLoginAttempted.current) return
    autoLoginAttempted.current = true
    const deviceId = getAccountDeviceId()
    if (!deviceId || deviceId === 'ephemeral-session') return
    void autoLoginGatewayAccount(server.id, deviceId)
      .then(() => {
        return onChanged()
      })
      .catch(() => {
        // No remembered credential or the server rejected it: stay anonymous.
      })
  }, [authenticated, onChanged, server.id])

  useEffect(
    () =>
      listenAccountContextChanges(targetId => {
        if (targetId !== server.id) return
        void onChanged()
      }),
    [onChanged, server.id]
  )

  if (!server.security && !server.accountIdentity) return null

  const runLogout = async () => {
    setBusy(true)
    setError('')
    try {
      await logoutGatewayAccount(server.id, getAccountDeviceId())
      setConfirmAction(null)
      setUsername('')
      await onChanged()
      window.setTimeout(() => usernameInputRef.current?.focus(), 0)
    } catch (value) {
      setError(value instanceof Error ? value.message : t('accounts.failed'))
    } finally {
      setPassword('')
      setBusy(false)
    }
  }

  const runLogin = async () => {
    setBusy(true)
    setError('')
    try {
      await loginGatewayAccount(server.id, {
        username: username.trim(),
        password,
        ...(remember ? { remember: true } : {}),
        deviceId: getAccountDeviceId(),
      })
      setConfirmAction(null)
      await onChanged()
    } catch (value) {
      setError(value instanceof Error ? value.message : t('accounts.failed'))
    } finally {
      setPassword('')
      setBusy(false)
    }
  }

  const submit = (event: React.FormEvent) => {
    event.preventDefault()
    if (!busy) void runLogin()
  }

  return (
    <section className="mt-3" data-testid="kcoder-account-login">
      {authenticated ? (
        <>
          <p className="text-sm text-text-secondary">
            {t('accounts.identity', { username: server.accountIdentity?.username ?? '' })}
          </p>
          {confirmAction ? (
            <div role="alertdialog" aria-label={t('accounts.logout')} className="mt-2 text-sm">
              <p>
                {confirmAction === 'switch'
                  ? t('accounts.switchWarning')
                  : t('accounts.logoutWarning')}
              </p>
              <Button
                disabled={busy}
                onClick={() => void runLogout()}
                data-testid="kcoder-account-confirm-logout"
              >
                {confirmAction === 'switch' ? t('accounts.switchConfirm') : t('accounts.logout')}
              </Button>
              <Button
                variant="ghost"
                disabled={busy}
                onClick={() => setConfirmAction(null)}
                data-testid="kcoder-account-cancel-logout"
              >
                {t('accounts.cancel')}
              </Button>
            </div>
          ) : (
            <div className="mt-2 flex flex-wrap gap-2">
              <Button
                variant="ghost"
                onClick={() => setConfirmAction('switch')}
                data-testid="kcoder-account-switch"
              >
                {t('accounts.switch')}
              </Button>
              <Button
                variant="ghost"
                onClick={() => setConfirmAction('logout')}
                data-testid="kcoder-account-logout"
              >
                {t('accounts.logout')}
              </Button>
            </div>
          )}
        </>
      ) : (
        <form className="mt-2 flex flex-wrap items-end gap-2" onSubmit={submit}>
          <label className="text-sm text-text-secondary">
            {t('accounts.username')}
            <input
              ref={usernameInputRef}
              data-testid="kcoder-account-username"
              type="text"
              required
              maxLength={32}
              autoComplete="username"
              value={username}
              onChange={event => setUsername(event.target.value)}
              disabled={busy}
              placeholder={hintUsername || undefined}
              className="mt-1 block h-9 w-44 rounded-lg border border-border bg-background px-3 text-sm max-md:h-11"
            />
          </label>
          <label className="text-sm text-text-secondary">
            {t('accounts.password')}
            <input
              data-testid="kcoder-account-password"
              type="password"
              required
              maxLength={1024}
              autoComplete="current-password"
              value={password}
              onChange={event => setPassword(event.target.value)}
              disabled={busy}
              className="mt-1 block h-9 rounded-lg border border-border bg-background px-3 text-sm max-md:h-11"
            />
          </label>
          <label className="flex items-center gap-1.5 text-sm text-text-secondary">
            <Checkbox
              data-testid="kcoder-account-remember"
              checked={remember}
              onChange={event => setRemember(event.target.checked)}
              disabled={busy}
              className="h-4 w-4"
            />
            {t('accounts.remember')}
          </label>
          <Button type="submit" disabled={busy} data-testid="kcoder-account-submit">
            {t('accounts.login')}
          </Button>
        </form>
      )}
      {error && (
        <p role="alert" className="mt-2 text-sm text-red-500">
          {error}
        </p>
      )}
    </section>
  )
}
