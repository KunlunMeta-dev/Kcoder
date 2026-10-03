import { useState } from 'react'
import { useTranslation } from '@/hooks/useTranslation'
import { manageGatewayAccounts } from '@/kcoder/gatewayRpc'
import { RuntimeTargetConfirmDialog } from './RuntimeTargetConfirmDialog'
import { Button } from '@/components/ui/button'

interface Account {
  id: string
  username: string
  role: 'admin' | 'user'
  disabled: boolean
}

export function KCoderAccountManagement({ serverId }: { serverId: string }) {
  const { t } = useTranslation('localRuntime')
  const [open, setOpen] = useState(false)
  const [accounts, setAccounts] = useState<Account[]>([])
  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [revoking, setRevoking] = useState<Account | null>(null)
  const run = async (operation: Record<string, unknown>) => {
    setBusy(true)
    setError('')
    try {
      await manageGatewayAccounts(serverId, operation)
      setAccounts(await manageGatewayAccounts<Account[]>(serverId, { operation: 'list' }))
      setOpen(true)
      setPassword('')
    } catch {
      setError(t('accounts.failed'))
    } finally {
      setPassword('')
      setBusy(false)
    }
  }
  const exportAccounts = async () => {
    setBusy(true)
    setError('')
    try {
      const identities = await manageGatewayAccounts(serverId, { operation: 'export' })
      const url = URL.createObjectURL(
        new Blob([JSON.stringify(identities, null, 2)], { type: 'application/json' })
      )
      const link = document.createElement('a')
      link.href = url
      link.download = 'kcoder-identities.json'
      link.click()
      setTimeout(() => URL.revokeObjectURL(url), 1000)
    } catch {
      setError(t('accounts.failed'))
    } finally {
      setBusy(false)
    }
  }
  return (
    <section className="mt-2" data-testid="kcoder-account-management">
      <Button variant="ghost" disabled={busy} onClick={() => void run({ operation: 'list' })}>
        {t('accounts.manage')}
      </Button>
      {open && (
        <div className="mt-2 space-y-3 rounded-lg border border-border p-3">
          <p className="text-xs text-text-secondary">{t('accounts.migrationHelp')}</p>
          <form
            className="flex flex-wrap items-end gap-2"
            onSubmit={event => {
              event.preventDefault()
              void run({ operation: 'create', username, password, role: 'user' })
            }}
          >
            <label className="text-sm">
              {t('accounts.username')}
              <input
                data-testid="kcoder-account-new-username"
                required
                value={username}
                onChange={event => setUsername(event.target.value)}
                autoComplete="off"
                className="mt-1 block h-9 rounded border border-border bg-background px-2 max-md:h-11"
              />
            </label>
            <label className="text-sm">
              {t('accounts.password')}
              <input
                data-testid="kcoder-account-new-password"
                required
                type="password"
                value={password}
                onChange={event => setPassword(event.target.value)}
                autoComplete="new-password"
                className="mt-1 block h-9 rounded border border-border bg-background px-2 max-md:h-11"
              />
            </label>
            <Button data-testid="kcoder-account-create" type="submit" disabled={busy}>
              {t('accounts.create')}
            </Button>
          </form>
          {accounts.map(account => (
            <div key={account.id} className="flex flex-wrap items-center gap-2 text-sm">
              <span>
                {account.username} · {account.role}
              </span>
              <Button variant="ghost" disabled={busy} onClick={() => setRevoking(account)}>
                {t('accounts.revoke')}
              </Button>
              <Button
                variant="ghost"
                disabled={busy}
                onClick={() =>
                  void run({
                    operation: account.disabled ? 'enable' : 'disable',
                    username: account.username,
                  })
                }
              >
                {t(account.disabled ? 'accounts.enable' : 'accounts.disable')}
              </Button>
            </div>
          ))}
          <div className="flex flex-wrap gap-2">
            <Button variant="outline" disabled={busy} onClick={() => void exportAccounts()}>
              {t('accounts.export')}
            </Button>
            <label className="text-sm">
              {t('accounts.import')}
              <input
                type="file"
                accept="application/json,.json"
                disabled={busy}
                onChange={event => {
                  const file = event.target.files?.[0]
                  event.target.value = ''
                  if (!file) return
                  if (file.size > 4 * 1024 * 1024) {
                    setError(t('accounts.failed'))
                    return
                  }
                  void file
                    .text()
                    .then(text => run({ operation: 'import', bundle: JSON.parse(text) }))
                    .catch(() => setError(t('accounts.failed')))
                }}
              />
            </label>
          </div>
        </div>
      )}
      {revoking && (
        <RuntimeTargetConfirmDialog
          title={t('accounts.revoke')}
          description={t('accounts.revokeHelp')}
          confirmLabel={t('accounts.revoke')}
          cancelLabel={t('accounts.cancel')}
          closeLabel={t('accounts.cancel')}
          testId="account-revoke-dialog"
          onCancel={() => setRevoking(null)}
          onConfirm={() => {
            const account = revoking
            setRevoking(null)
            void run({ operation: 'revoke', username: account.username })
          }}
        />
      )}
      {error && (
        <p role="alert" className="mt-2 text-sm text-red-500">
          {error}
        </p>
      )}
    </section>
  )
}
