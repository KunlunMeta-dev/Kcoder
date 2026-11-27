import { useEffect, useRef, useState } from 'react'
import { Alert, Button, Drawer, Form, Input, Segmented } from 'antd'
import { useTranslation } from '@/hooks/useTranslation'
import { createRandomUuid } from '@/lib/random-id'
import { useEscapeKey } from '@/hooks/useEscapeKey'
import { channelAction, ChannelRequestError, type ChannelAuthorization, type ChannelConnection, type ChannelPlatform } from '@/kcoder/channels'
import { ChannelAuthentication } from './ChannelAuthentication'
import { ChannelFeatureSettings } from './ChannelFeatureSettings'
import { channelPlatforms } from '@/kcoder/channelPlatforms'
import styles from '@/features/octop/channels.module.css'

export function ChannelConnectionEditor({ platform, connection, onSaved, onClose }: {
  platform: ChannelPlatform; connection?: ChannelConnection
  onSaved: () => void; onClose: () => void
}) {
  const { t } = useTranslation('connectivity')
  const definition = channelPlatforms[platform]
  const qrPlatform = definition.authentication === 'qr'
  const [id] = useState(() => connection?.id ?? `${platform}-${createRandomUuid()}`)
  const [label, setLabel] = useState(() => connection?.label ?? `${t(`gatewayChannels.platform.${platform}`)} · ${new Date().toLocaleString(undefined, { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' })}`)
  const [identity, setIdentity] = useState(String(connection?.configuration[definition.identityField] ?? ''))
  const [repositories, setRepositories] = useState(Array.isArray(connection?.configuration.repositories) ? connection.configuration.repositories.join('\n') : '')
  const [secret, setSecret] = useState('')
  const [features, setFeatures] = useState<Record<string, unknown>>(() => ({
    ...Object.fromEntries(Object.entries(definition.featureFields).map(([key, field]) => [key, field.default])),
    ...(platform === 'github' && connection?.configuration.pollIntervalSeconds !== undefined
      ? { pollIntervalSeconds: connection.configuration.pollIntervalSeconds } : {}),
    meta: { config_version: 1 }, ...(connection?.configuration.features as Record<string, unknown> | undefined),
  }))
  const [mode, setMode] = useState<'quick' | 'manual'>(() => !connection?.hasCredential && qrPlatform ? 'quick' : 'manual')
  const [flow, setFlow] = useState<ChannelAuthorization | null>(null)
  const [busy, setBusy] = useState(false)
  const [uncertain, setUncertain] = useState(false)
  const [error, setError] = useState('')
  const owner = useRef<AbortController | null>(null), lock = useRef(false)
  const attemptedFlow = useRef<string | null>(null)
  useEscapeKey(onClose)
  useEffect(() => {
    const lifetime = new AbortController(); owner.current = lifetime
    return () => { lifetime.abort(); owner.current = null }
  }, [])
  const save = async (authorized?: ChannelAuthorization) => {
    if (!owner.current || lock.current || uncertain) return
    const signal = owner.current.signal
    lock.current = true; setBusy(true); setError('')
    try {
      if (mode === 'quick' && qrPlatform) {
        const ready = authorized ?? flow
        if (ready?.state !== 'ready') return
        const result = await channelAction<ChannelAuthorization>({ action: 'authorization_commit', flowId: ready.flowId,
          label: label.trim() || `${t(`gatewayChannels.platform.${platform}`)} · ${id.slice(-6)}`, features }, signal)
        if (result.flowId !== ready.flowId || result.state !== 'saved' || result.connection?.id !== id
          || !Number.isSafeInteger(result.connection.revision) || result.connection.revision < 0) {
          throw new ChannelRequestError('CHANNEL_RESPONSE_UNKNOWN', true)
        }
      } else {
        const configuration: Record<string, unknown> = { ...connection?.configuration }
        configuration.features = features
        for (const [key, value] of Object.entries(definition.configurationDefaults ?? {})) configuration[key] ??= value
        let credentials: Record<string, unknown> | undefined
        configuration[definition.identityField] = identity.trim()
        if (platform === 'github') configuration.repositories = repositories.split(/[\s,]+/).filter(Boolean)
        if (secret) {
          credentials = { [definition.credentialField]: secret }
        }
        await channelAction({ action: 'save', connection: { id, platform, label: label.trim(), configuration },
          expectedRevision: connection?.revision ?? 0, ...(credentials ? { credentials } : {}) }, signal)
      }
      if (!signal.aborted) onSaved()
    } catch (error) {
      if (!signal.aborted) {
        setUncertain(error instanceof ChannelRequestError && error.uncertain)
        setError(error instanceof ChannelRequestError ? error.code : 'CHANNEL_OPERATION_FAILED')
      }
    } finally {
      lock.current = false
      if (!signal.aborted) { setBusy(false); setSecret('') }
    }
  }
  const quick = mode === 'quick' && qrPlatform
  return <Drawer getContainer={false} rootClassName="octop-surface octop-drawer-root"
    rootStyle={{ zIndex: 'calc(var(--z-modal) - 1)' }} open width={460} destroyOnHidden
    onClose={onClose} keyboard={false} title={t(connection ? 'connections.configure' : 'octop.createChannel')}
    footer={<div className={styles.drawerFooter}>
      <Button onClick={onClose}>{t('octop.cancel')}</Button>
      {quick ? <>
        <span role="status" className="min-w-0 flex-1 text-sm text-text-secondary">{t(busy ? 'gatewayChannels.savingVerifiedConnection' : 'gatewayChannels.autoSaveAfterScan')}</span>
        {error && !uncertain && flow?.state === 'ready' && <Button type="primary" disabled={busy} onClick={() => void save(flow)}>{t('gatewayChannels.retrySave')}</Button>}
      </> : <Button type="primary" loading={busy} disabled={busy || uncertain || connection?.enabled || !label.trim()
        || !identity.trim() || (!connection?.hasCredential && !secret)} onClick={() => void save()}>{t('octop.save')}</Button>}
    </div>}>
    <Form layout="vertical">
      {connection?.enabled && <Alert type="info" message={t('gatewayChannels.stopBeforeEdit')} />}
      <Form.Item label={t('octop.name')} required><Input aria-label={t('octop.name')}
        value={label} disabled={busy || uncertain} onChange={event => setLabel(event.target.value)} /></Form.Item>
      {qrPlatform && !connection?.hasCredential && <Segmented
        options={[{ value: 'quick', label: t('octop.quick') }, { value: 'manual', label: t('octop.manual') }]}
        value={mode} disabled={busy || uncertain} onChange={value => { setMode(value as 'quick' | 'manual'); setFlow(null) }} />}
      {quick ? <ChannelAuthentication key={mode} platform={platform} connectionId={id}
        revision={connection?.revision ?? 0} onChange={next => {
          setFlow(next)
          if (next?.state === 'ready' && attemptedFlow.current !== next.flowId) {
            // One automatic commit per verified flow; an uncertain receipt is never replayed.
            attemptedFlow.current = next.flowId; void save(next)
          }
        }} /> : <>
        <Form.Item label={t(`gatewayChannels.identity.${platform}`)} required>
          <Input aria-label={t(`gatewayChannels.identity.${platform}`)} value={identity}
            disabled={busy || uncertain || !!connection?.hasCredential} autoComplete="off"
            onChange={event => setIdentity(event.target.value)} /></Form.Item>
        {platform === 'github' && <Form.Item label={t('gatewayChannels.repositories')} required>
          <Input.TextArea aria-label={t('gatewayChannels.repositories')} value={repositories}
            disabled={busy || uncertain} onChange={event => setRepositories(event.target.value)} rows={3} />
        </Form.Item>}
        <Form.Item label={t(`gatewayChannels.secret.${platform}`)} required={!connection?.hasCredential}>
          <Input.Password aria-label={t(`gatewayChannels.secret.${platform}`)} value={secret} disabled={busy || uncertain}
            autoComplete="new-password" placeholder={connection?.hasCredential ? t('octop.secretSaved') : ''}
            onChange={event => setSecret(event.target.value)} />
        </Form.Item>
      </>}
      <ChannelFeatureSettings platform={platform} value={features} onChange={setFeatures}
        disabled={busy || uncertain || !!connection?.enabled} />
    </Form>
    {error && <Alert type="error" message={t(uncertain ? 'gatewayChannels.saveUnknown' : 'octop.failed')}
      description={<code>{error}</code>} />}
  </Drawer>
}
