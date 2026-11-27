import { useEffect, useRef, useState, useLayoutEffect } from 'react'
import { Button } from '@/components/ui/button'
import { useTranslation } from '@/hooks/useTranslation'
import { openExternalUrl } from '@/lib/external-links'
import {
  cancelGatewayAccountOidc,
  readGatewayAccountOidc,
  startGatewayAccountOidc,
} from '@/kcoder/gatewayAccountOidc'
import { notifyAccountContextChange } from '@/kcoder/accountContextEvents'

interface Pending {
  serverId: string
  clientRequestId: string
  abort: AbortController
  timer?: ReturnType<typeof setTimeout>
}

export function KCoderAccountOidc({
  serverId,
  username,
  disabled,
  onBusy,
  onChanged,
}: {
  serverId: string
  username: string
  disabled: boolean
  onBusy: (busy: boolean) => void
  onChanged: () => Promise<void>
}) {
  const { t, i18n } = useTranslation('localRuntime')
  const [url, setUrl] = useState('')
  const [waiting, setWaiting] = useState(false)
  const [error, setError] = useState('')
  const pending = useRef<Pending | null>(null)
  const mounted = useRef(true)
  const currentTarget = useRef(serverId)
  useLayoutEffect(() => { currentTarget.current = serverId }, [serverId])
  const cancel = () => {
    const original = pending.current
    pending.current = null
    if (original) {
      original.abort.abort()
      if (original.timer) clearTimeout(original.timer)
      void cancelGatewayAccountOidc(original.serverId, original.clientRequestId).catch(() => {})
    }
    if (mounted.current) {
      setWaiting(false)
      setUrl('')
      onBusy(false)
    }
  }
  const [previousTarget, setPreviousTarget] = useState(serverId)
  if (previousTarget !== serverId) { setPreviousTarget(serverId); setWaiting(false); setUrl(''); setError('') }
  useEffect(() => {
    mounted.current = true
    onBusy(false)
    return () => {
      mounted.current = false
      const original = pending.current
      pending.current = null
      if (original) {
        original.abort.abort()
        if (original.timer) clearTimeout(original.timer)
        void cancelGatewayAccountOidc(original.serverId, original.clientRequestId).catch(() => {})
      }
    }
  }, [serverId, onBusy])

  const begin = async () => {
    if (!/^[a-z][a-z0-9_.-]{1,31}$/.test(username.trim())) {
      setError(t('accounts.sso.usernameRequired'))
      return
    }
    cancel()
    const original: Pending = {
      serverId,
      clientRequestId: crypto.randomUUID(),
      abort: new AbortController(),
    }
    pending.current = original
    const owns = () =>
      mounted.current && pending.current === original && currentTarget.current === original.serverId
    setWaiting(true)
    setError('')
    onBusy(true)
    try {
      const challenge = await startGatewayAccountOidc(
        original.serverId,
        username.trim(),
        original.clientRequestId,
        i18n?.language ?? 'zh-CN',
        original.abort.signal
      )
      if (!owns()) return
      if (
        challenge.clientRequestId !== original.clientRequestId ||
        !Number.isInteger(challenge.expiresIn) ||
        challenge.expiresIn < 1 ||
        challenge.expiresIn > 180
      )
        throw new Error(t('accounts.sso.failed'))
      const authorization = new URL(challenge.authorizationUrl)
      if (
        authorization.protocol !== 'https:' ||
        authorization.username ||
        authorization.password ||
        authorization.hash
      )
        throw new Error(t('accounts.sso.failed'))
      setUrl(challenge.authorizationUrl)
      void openExternalUrl(challenge.authorizationUrl, { target: 'system' }).catch(() => {})
      const deadline = Date.now() + Math.min(challenge.expiresIn + 45, 225) * 1000
      const poll = async () => {
        if (!owns()) return
        try {
          if (Date.now() >= deadline) throw new Error(t('accounts.sso.expired'))
          const status = await readGatewayAccountOidc(
            original.serverId,
            original.clientRequestId,
            original.abort.signal
          )
          if (!owns()) return
          if (status.status === 'failed') throw new Error(t('accounts.sso.failed'))
          if (status.status === 'authenticated') {
            pending.current = null
            setWaiting(false)
            setUrl('')
            onBusy(false)
            notifyAccountContextChange(original.serverId)
            await onChanged()
            return
          }
          original.timer = setTimeout(() => void poll(), 500)
        } catch (value) {
          if (!owns()) return
          setError(
            value instanceof Error && value.message === t('accounts.sso.expired')
              ? value.message
              : t('accounts.sso.failed')
          )
          cancel()
        }
      }
      void poll()
    } catch {
      if (!owns()) return
      setError(t('accounts.sso.failed'))
      cancel()
    }
  }
  return (
    <div className="space-y-2" data-testid="kcoder-account-oidc">
      {!waiting && (
        <Button
          type="button"
          variant="outline"
          disabled={disabled}
          onClick={() => void begin()}
          data-testid="kcoder-account-sso-start"
        >
          {t('accounts.sso.login')}
        </Button>
      )}
      {waiting && (
        <div className="space-y-2">
          <p role="status" className="text-sm text-text-secondary">
            {t('accounts.sso.waiting')}
          </p>
          <div className="flex flex-wrap gap-2">
            {url && (
              <Button
                type="button"
                variant="outline"
                onClick={() => void openExternalUrl(url, { target: 'system' })}
              >
                {t('accounts.sso.open')}
              </Button>
            )}
            <Button
              type="button"
              variant="ghost"
              onClick={cancel}
              data-testid="kcoder-account-sso-cancel"
            >
              {t('accounts.cancel')}
            </Button>
          </div>
        </div>
      )}
      {error && (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      )}
    </div>
  )
}
