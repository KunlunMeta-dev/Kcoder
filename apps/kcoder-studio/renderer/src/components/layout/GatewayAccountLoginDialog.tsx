import { Checkbox } from '@/components/ui/checkbox'
import { useState } from 'react'
import { createPortal } from 'react-dom'
import { useEscapeKey } from '@/hooks/useEscapeKey'
import { useTranslation } from '@/hooks/useTranslation'
import { getAccountDeviceId, loginGatewayAccount, type GatewayServer } from '@/kcoder/gatewayRpc'
import { Button } from '@/components/ui/button'
import { Loader2 } from 'lucide-react'

interface GatewayAccountLoginDialogProps {
  server: GatewayServer
  onDone: () => void
  onCancel: () => void
}

// Inline login for a gateway account target, opened from the sidebar account
// menu so switching accounts never requires a detour through settings.
export function GatewayAccountLoginDialog({
  server,
  onDone,
  onCancel,
}: GatewayAccountLoginDialogProps) {
  const { t } = useTranslation('localRuntime')
  const [username, setUsername] = useState(server.security?.identity.username ?? '')
  const [password, setPassword] = useState('')
  const [remember, setRemember] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  useEscapeKey(onCancel, !busy)

  const submit = async (event: React.FormEvent) => {
    event.preventDefault()
    if (busy) return
    setBusy(true)
    setError('')
    try {
      await loginGatewayAccount(server.id, {
        username: username.trim(),
        password,
        ...(remember ? { remember: true } : {}),
        deviceId: getAccountDeviceId(),
      })
      onDone()
    } catch (value) {
      setError(value instanceof Error ? value.message : t('accounts.failed'))
    } finally {
      setBusy(false)
    }
  }

  return createPortal(
    <div className="fixed inset-0 z-modal flex items-center justify-center bg-black/25 px-4">
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="gateway-account-login-dialog-title"
        data-testid="gateway-account-login-dialog"
        onKeyDown={event => {
          if (event.key === 'Tab') event.preventDefault()
        }}
        className="w-full max-w-[420px] rounded-[20px] border border-border bg-popover p-5 text-text-primary shadow-lg"
      >
        <h2 id="gateway-account-login-dialog-title" className="heading-sm text-text-primary">
          {t('accounts.login')} · {server.label}
        </h2>
        <form
          className="mt-4 space-y-3"
          onSubmit={event => {
            void submit(event)
          }}
        >
          <label className="block text-xs font-medium text-text-secondary">
            {t('accounts.username')}
            <input
              data-testid="gateway-account-dialog-username"
              type="text"
              required
              maxLength={32}
              autoComplete="username"
              value={username}
              onChange={event => setUsername(event.target.value)}
              disabled={busy}
              className="mt-1 block h-9 w-full rounded-lg border border-border bg-background px-3 text-sm"
            />
          </label>
          <label className="block text-xs font-medium text-text-secondary">
            {t('accounts.password')}
            <input
              data-testid="gateway-account-dialog-password"
              type="password"
              required
              maxLength={1024}
              autoComplete="current-password"
              value={password}
              onChange={event => setPassword(event.target.value)}
              disabled={busy}
              className="mt-1 block h-9 w-full rounded-lg border border-border bg-background px-3 text-sm"
            />
          </label>
          <label className="flex items-center gap-1.5 text-sm text-text-secondary">
            <Checkbox
              data-testid="gateway-account-dialog-remember"
              checked={remember}
              onChange={event => setRemember(event.target.checked)}
              disabled={busy}
              className="h-4 w-4"
            />
            {t('accounts.remember')}
          </label>
          {error && (
            <p role="alert" className="text-sm text-red-500">
              {error}
            </p>
          )}
          <div className="flex justify-end gap-2 pt-1">
            <Button
              type="button"
              variant="secondary"
              size="sm"
              disabled={busy}
              onClick={onCancel}
              data-testid="gateway-account-dialog-cancel"
            >
              {t('accounts.cancel')}
            </Button>
            <Button
              type="submit"
              size="sm"
              disabled={busy}
              data-testid="gateway-account-dialog-submit"
            >
              {busy && <Loader2 className="h-3 w-3 animate-spin" aria-hidden="true" />}
              {t('accounts.login')}
            </Button>
          </div>
        </form>
      </div>
    </div>,
    document.body
  )
}
