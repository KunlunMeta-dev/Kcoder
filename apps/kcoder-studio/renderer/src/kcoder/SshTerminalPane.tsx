import { useCallback, useEffect, useRef, useState } from 'react'
import { useTranslation } from '@/hooks/useTranslation'
import { RemoteTerminal } from '@/components/layout/workspace-panels/RemoteTerminal'
import { Button } from '@/components/ui/button'
import {
  SshTerminalConnection,
  type SshConnectionProfile,
  type SshConnectResult,
} from './sshTerminal'

export function SshTerminalPane({
  profile,
  active,
  sessionId,
}: {
  profile: SshConnectionProfile
  active: boolean
  sessionId: string
}) {
  const { t } = useTranslation('sshTerminal')
  const [password, setPassword] = useState('')
  const [passphrase, setPassphrase] = useState('')
  const [busy, setBusy] = useState(false)
  const [connected, setConnected] = useState(false)
  const [hasTerminal, setHasTerminal] = useState(false)
  const [error, setError] = useState('')
  const [challenge, setChallenge] = useState<SshConnectResult | null>(null)
  const [generation, setGeneration] = useState(0)
  const connection = useRef<SshTerminalConnection | null>(null)
  const mounted = useRef(true)
  const operation = useRef(0)

  useEffect(() => {
    mounted.current = true
    return () => {
      mounted.current = false
      operation.current += 1
      connection.current?.dispose()
    }
  }, [])

  const cancel = () => {
    operation.current += 1
    connection.current?.dispose()
    connection.current = null
    setBusy(false)
    setConnected(false)
    setChallenge(null)
    setPassword('')
    setPassphrase('')
  }

  const connect = async (acceptFingerprint?: string) => {
    const attempt = ++operation.current
    setBusy(true)
    setError('')
    if (!acceptFingerprint || !connection.current) {
      connection.current?.dispose()
      const current = new SshTerminalConnection(() => {
        if (mounted.current && connection.current === current) setConnected(false)
      })
      connection.current = current
      setHasTerminal(false)
      setGeneration(value => value + 1)
    }
    const current = connection.current!
    try {
      const result = await current.connect(profile.id, {
        ...(profile.authMethod === 'password' && password ? { password } : {}),
        ...(profile.authMethod === 'key' && passphrase ? { passphrase } : {}),
        ...(acceptFingerprint ? { acceptFingerprint } : {}),
      })
      if (!mounted.current || operation.current !== attempt) return
      if (result.status === 'host-key-required') setChallenge(result)
      else {
        setChallenge(null)
        setPassword('')
        setPassphrase('')
        setConnected(true)
        setHasTerminal(true)
      }
    } catch (failure) {
      if (!mounted.current || operation.current !== attempt) return
      setChallenge(null)
      setPassword('')
      setPassphrase('')
      setError(failure instanceof Error ? failure.message : t('failed'))
    } finally {
      if (mounted.current && operation.current === attempt) setBusy(false)
    }
  }

  const clientFactory = useCallback((id: string) => {
    if (!connection.current) throw new Error('SSH terminal is closed')
    return connection.current.createTerminalClient(id)
  }, [])

  return (
    <section data-testid="ssh-terminal-pane" className="flex h-full min-h-0 flex-col">
      <div className="flex min-h-8 shrink-0 items-center gap-2 px-3 text-sm">
        <span
          className="min-w-0 flex-1 truncate"
          title={`${profile.username}@${profile.host}:${profile.port}`}
        >
          {profile.username}@{profile.host}:{profile.port}
        </span>
        <span role="status">
          {busy ? t('connecting') : connected ? t('connected') : t('disconnected')}
        </span>
        {(connected || busy || challenge) && (
          <Button size="sm" variant="ghost" onClick={cancel} data-testid="ssh-disconnect">
            {busy || challenge ? t('cancel') : t('disconnect')}
          </Button>
        )}
      </div>
      {!connected && !challenge && (
        <form
          className="flex shrink-0 flex-wrap items-end gap-2 px-3 py-2"
          onSubmit={event => {
            event.preventDefault()
            void connect()
          }}
        >
          {profile.authMethod === 'password' && (
            <label className="text-sm">
              {t('password')}
              <input
                data-testid="ssh-password"
                type="password"
                autoComplete="off"
                value={password}
                placeholder={profile.passwordSaved ? t('savedPassword') : undefined}
                disabled={busy}
                onChange={event => setPassword(event.target.value)}
                className="ml-2 h-8 rounded-lg border border-border bg-background px-2"
                required={!profile.passwordSaved}
              />
            </label>
          )}
          {profile.authMethod === 'key' && (
            <label className="text-sm">
              {t('passphrase')}
              <input
                data-testid="ssh-passphrase"
                type="password"
                autoComplete="off"
                value={passphrase}
                disabled={busy}
                onChange={event => setPassphrase(event.target.value)}
                className="ml-2 h-8 rounded-lg border border-border bg-background px-2"
              />
            </label>
          )}
          <Button size="sm" type="submit" disabled={busy} data-testid="ssh-connect">
            {hasTerminal ? t('reconnect') : t('connect')}
          </Button>
          <span className="text-xs text-text-secondary">{t('gatewayNote')}</span>
        </form>
      )}
      {error && (
        <p role="alert" className="px-3 py-2 text-sm text-red-500">
          {t('failed')}: {error}
        </p>
      )}
      {challenge && (
        <div role="alert" className="space-y-2 px-3 py-2 text-sm">
          <p>{t('hostKeyPrompt', { host: challenge.host, port: challenge.port })}</p>
          <code className="block break-all select-text" data-testid="ssh-host-fingerprint">
            {challenge.fingerprint}
          </code>
          <p className="text-text-secondary">{t('hostKeyHelp')}</p>
          <Button
            size="sm"
            disabled={busy}
            data-testid="ssh-confirm-host"
            onClick={() => void connect(challenge.fingerprint)}
          >
            {t('trustConnect')}
          </Button>
        </div>
      )}
      {hasTerminal && (
        <div className="relative min-h-0 flex-1">
          <RemoteTerminal
            key={generation}
            sessionId={sessionId}
            clientFactory={clientFactory}
            active={active}
            testIdsEnabled
          />
        </div>
      )}
    </section>
  )
}
