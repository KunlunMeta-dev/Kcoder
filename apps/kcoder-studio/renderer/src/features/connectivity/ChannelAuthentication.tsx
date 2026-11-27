import { useCallback, useEffect, useRef, useState } from 'react'
import { QRCodeSVG } from 'qrcode.react'
import { Button, Input } from 'antd'
import { useTranslation } from '@/hooks/useTranslation'
import { createRandomUuid } from '@/lib/random-id'
import { channelAction, ChannelRequestError, type ChannelAuthorization, type ChannelPlatform } from '@/kcoder/channels'

/** A disposable initial-login flow. Credentials never cross back to the renderer. */
export function ChannelAuthentication({ platform, connectionId, revision, onChange }: {
  platform: ChannelPlatform; connectionId: string; revision: number
  onChange: (flow: ChannelAuthorization | null) => void
}) {
  const { t } = useTranslation('connectivity')
  const [flowId, setFlowId] = useState(createRandomUuid)
  const [state, setState] = useState<ChannelAuthorization | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [verifyCode, setVerifyCode] = useState('')
  const owner = useRef<AbortController | null>(null)
  const lock = useRef<AbortController | null>(null)
  const began = useRef(false)
  const changed = useRef(onChange)
  useEffect(() => { changed.current = onChange }, [onChange])
  useEffect(() => {
    const lifetime = new AbortController(); owner.current = lifetime
    return () => {
      lifetime.abort()
      if (owner.current === lifetime) owner.current = null
      // A StrictMode effect replay keeps the same original flow; a real close cancels it.
      queueMicrotask(() => {
        if (!owner.current && began.current) void channelAction({ action: 'authorization_cancel', flowId }).catch(() => {})
      })
    }
  }, [flowId])
  const run = useCallback(async (create = false) => {
    if (!owner.current || owner.current.signal.aborted || lock.current && !lock.current.signal.aborted) return
    const lifetime = owner.current, signal = lifetime.signal
    lock.current = lifetime; setBusy(true); setError('')
    try {
      if (create) began.current = true
      const next = await channelAction<ChannelAuthorization>(create
        ? { action: 'authorization_begin', flowId, platform, connectionId, expectedRevision: revision }
        : { action: 'authorization_poll', flowId, ...(verifyCode ? { verifyCode } : {}) }, signal)
      if (signal.aborted) return
      setState(next); changed.current(next)
    } catch (error) {
      if (!signal.aborted) setError(error instanceof ChannelRequestError ? error.code : 'CHANNEL_AUTHENTICATION_FAILED')
    } finally {
      if (lock.current === lifetime) lock.current = null
      if (!signal.aborted) setBusy(false)
    }
  }, [flowId, platform, connectionId, revision, verifyCode])
  useEffect(() => { if (!state) void run(true) }, [run, state])
  useEffect(() => {
    if (!state || error || !['waiting', 'scanned'].includes(state.state)) return
    const timer = window.setTimeout(() => void run(), state.intervalMs ?? 2000)
    return () => window.clearTimeout(timer)
  }, [state, error, run])
  const phase = error ? 'unavailable' : state?.state === 'saved' ? 'bound' : state?.state
  const terminal = !!state && ['expired', 'denied', 'cancelled', 'verification_blocked', 'already_bound', 'unavailable'].includes(state.state)
  const restart = () => {
    void channelAction({ action: 'authorization_cancel', flowId }).catch(() => {})
    began.current = false; changed.current(null); setState(null); setError(''); setVerifyCode(''); setFlowId(createRandomUuid())
  }
  return <div className="space-y-3" data-testid="channel-initial-authentication">
    <p className="text-sm text-text-secondary">{t(`gatewayChannels.authenticationHint.${platform}`)}</p>
    {state?.verificationUrl && <div className="flex justify-center rounded-lg bg-white p-4">
      {state.verificationKind === 'image'
        ? <img src={state.verificationUrl} width={192} height={192} referrerPolicy="no-referrer" alt={t(`gatewayChannels.authenticationHint.${platform}`)} />
        : <QRCodeSVG value={state.verificationUrl} size={192} level="M" />}
    </div>}
    {state?.verificationKind !== 'image' && state?.verificationUrl && <a href={state.verificationUrl} target="_blank" rel="noopener noreferrer"
      className="text-sm text-primary">{t('gatewayChannels.openAuthentication')}</a>}
    {phase && <p role="status">{t(`gatewayChannels.authenticationState.${phase}`)}</p>}
    {phase === 'verification_required' && <Input aria-label={t('gatewayChannels.verificationCode')}
      value={verifyCode} onChange={event => setVerifyCode(event.target.value)} autoComplete="one-time-code" inputMode="numeric" />}
    {error && <p role="alert" className="break-all text-sm text-destructive">{t(error === 'WEIXIN_QR_NETWORK_UNAVAILABLE'
      ? 'gatewayChannels.authenticationNetworkFailed' : 'gatewayChannels.authenticationFailed')} <code>{error}</code></p>}
    <Button loading={busy} disabled={busy || phase === 'ready' || phase === 'bound'}
      onClick={() => terminal ? restart() : void run(!began.current)}>{t(terminal ? 'gatewayChannels.newAuthentication' : state || error ? 'octop.recover' : 'feishuRegistration.create')}</Button>
  </div>
}
