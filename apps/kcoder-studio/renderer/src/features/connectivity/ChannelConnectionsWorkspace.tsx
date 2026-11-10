// Gateway-owned connections are grouped by platform and instance.
import { useEffect, useId, useRef, useState } from 'react'
import { Alert, Button, Modal, Popconfirm, Switch } from 'antd'
import { ChevronRight, Plus, RefreshCw } from 'lucide-react'
import { useTranslation } from '@/hooks/useTranslation'
import { channelAction, channelInventory, ChannelRequestError, type ChannelConnection, type ChannelInventory, type ChannelPlatform } from '@/kcoder/channels'
import { ChannelToolRestrictionsNotice } from './ChannelToolRestrictionsNotice'
import { ChannelConnectionEditor } from './ChannelConnectionEditor'
import { ChannelChatList } from './ChannelChatList'
import { ChannelLabelEditor } from './ChannelLabelEditor'
import { ChannelTime } from './ChannelChatSummary'
import { channelConnectionIdentity } from './channelPresentation'
import styles from '@/features/octop/channels.module.css'
import feishu from '@/features/octop/assets/feishu.svg'
import weixin from '@/features/octop/assets/weixin.svg'
import qq from '@/features/octop/assets/qq.svg'
import wecom from '@/features/octop/assets/wecom.svg'
import dingtalk from '@/features/octop/assets/dingtalk.svg'
import github from '@/assets/channel-icons/github.svg'

// Presentation owns icon assets/order; metadata and platform membership are shared.
const icons: Record<ChannelPlatform, string> = { weixin, qq, wecom, feishu, github, dingtalk }
const catalogue = (Object.keys(icons) as ChannelPlatform[]).map(platform => ({ platform, icon: icons[platform] }))
export function ChannelConnectionsWorkspace() {
  const { t } = useTranslation('connectivity')
  const syncLabelId = useId(), syncDescriptionId = useId()
  const [inventory, setInventory] = useState<ChannelInventory | null>(null)
  const [reading, setReading] = useState(true)
  const [busy, setBusy] = useState<ReadonlySet<string>>(() => new Set())
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(() => new Set())
  const [choosingPlatform, setChoosingPlatform] = useState(false)
  const [editor, setEditor] = useState<{ platform: ChannelPlatform; connection?: ChannelConnection } | null>(null)
  const [error, setError] = useState('')
  const [code, setCode] = useState('')
  const [refresh, setRefresh] = useState(0)
  const owner = useRef<AbortController | null>(null), locks = useRef(new Set<string>())
  const readEpoch = useRef(0)
  const refreshInventory = () => {
    // A running instance operation already performs its own fenced inventory read.
    if (!locks.current.size) { setReading(true); setRefresh(value => value + 1) }
  }
  useEffect(() => {
    const lifetime = new AbortController(); owner.current = lifetime
    let pending = false
    const read = async () => {
      if (pending || lifetime.signal.aborted || locks.current.size) return
      pending = true; const epoch = ++readEpoch.current
      try {
        const result = await channelInventory(lifetime.signal)
        if (!lifetime.signal.aborted && epoch === readEpoch.current) { setInventory(result); setError(''); setCode('') }
      } catch (error) {
        if (!lifetime.signal.aborted && epoch === readEpoch.current) {
          setError('octop.readFailed'); setCode(error instanceof ChannelRequestError ? error.code : '')
        }
      } finally { pending = false; if (!lifetime.signal.aborted) setReading(false) }
    }
    void read()
    const poll = () => { if (document.visibilityState !== 'hidden') void read() }
    const timer = window.setInterval(poll, 10000)
    document.addEventListener('visibilitychange', poll)
    return () => {
      lifetime.abort(); window.clearInterval(timer); document.removeEventListener('visibilitychange', poll)
      if (owner.current === lifetime) owner.current = null
    }
  }, [refresh])
  const act = async (row: ChannelConnection, action: 'connect' | 'disconnect' | 'remove') => {
    if (!owner.current || locks.current.has(row.id)) return
    const signal = owner.current.signal
    locks.current.add(row.id); setBusy(new Set(locks.current)); setError(''); setCode('')
    readEpoch.current++
    try {
      if (action === 'remove') {
        let current = row
        if (row.enabled || ['connected', 'starting', 'degraded'].includes(row.state)) {
          current = await channelAction<ChannelConnection>({ action: 'disconnect', connectionId: row.id }, signal)
        }
        await channelAction({ action: 'remove', connectionId: row.id, expectedRevision: current.revision }, signal)
      } else await channelAction({ action, connectionId: row.id }, signal)
      const epoch = ++readEpoch.current
      const result = await channelInventory(signal)
      if (!signal.aborted && epoch === readEpoch.current) setInventory(result)
    } catch (error) {
      if (!signal.aborted) {
        setError(error instanceof ChannelRequestError && error.uncertain ? 'gatewayChannels.operationUnknown' : 'octop.failed')
        setCode(error instanceof ChannelRequestError ? error.code : '')
      }
    } finally {
      locks.current.delete(row.id)
      if (!signal.aborted) setBusy(new Set(locks.current))
    }
  }
  const saveClientSync = async (mirrorClientTurns: boolean) => {
    if (!owner.current || locks.current.size) return
    const signal = owner.current.signal
    locks.current.add('settings'); setBusy(new Set(locks.current)); setError(''); setCode('')
    readEpoch.current++
    try {
      const settings = await channelAction<ChannelInventory['settings']>({ action: 'settings', settings: { mirrorClientTurns } }, signal)
      if (!signal.aborted) setInventory(current => current ? { ...current, settings } : current)
    } catch (error) {
      if (!signal.aborted) {
        setError(error instanceof ChannelRequestError && error.uncertain ? 'gatewayChannels.operationUnknown' : 'octop.failed')
        setCode(error instanceof ChannelRequestError ? error.code : '')
      }
    } finally {
      locks.current.delete('settings')
      if (!signal.aborted) setBusy(new Set(locks.current))
    }
  }
  return <section className={styles.channelsPanel} data-testid="octop-channels-workspace">
    <div className={styles.channelsToolbar}>
      <div className="flex min-w-0 flex-wrap items-center gap-2"><h2 className="font-medium">{t('connections.instances')}</h2>
        <span className={styles.channelsStats}>{t('gatewayChannels.connectionCount', { count: inventory?.connections.length ?? 0 })}</span></div>
      <div className="flex shrink-0 gap-2">
        <Button icon={<Plus size={14} />} disabled={!inventory} data-testid="channel-add-connection" onClick={() => setChoosingPlatform(true)}>{t('connections.add')}</Button>
        <Button icon={<RefreshCw size={14} />} loading={reading} disabled={busy.size > 0}
          onClick={() => { setReading(true); setRefresh(value => value + 1) }}>{t('octop.refresh')}</Button>
      </div>
    </div>
    {error && <Alert type="error" message={t(error)} description={code ? <code>{code}</code> : undefined} />}
    <div className={styles.channelsBody}>
      <p className="mb-3 text-sm text-text-secondary">{t('gatewayChannels.scopeNotice')}</p>
      <div className="mb-6 space-y-2" data-testid="channel-connection-groups">
        {inventory?.connections.length === 0 && <p>{t('connections.empty')}</p>}
        {catalogue.map(platform => {
          const connections = inventory?.connections.filter(row => row.platform === platform.platform) ?? []
          if (!connections.length) return null
          const bound = inventory?.chats.filter(chat => chat.range.platform === platform.platform && chat.binding).length ?? 0
          return <details key={platform.platform} className="group/platform rounded-lg border border-border" data-testid="channel-platform-group" data-platform={platform.platform}>
            <summary className="flex min-h-11 cursor-pointer list-none items-center gap-3 rounded-lg px-3 py-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus [&::-webkit-details-marker]:hidden">
              <ChevronRight className="h-4 w-4 shrink-0 transition-transform group-open/platform:rotate-90" aria-hidden="true" />
              <img src={platform.icon} className="h-5 w-5 shrink-0" alt="" />
              <span className="font-medium">{t(`gatewayChannels.platform.${platform.platform}`)}</span>
              <span className="ml-auto text-sm text-text-secondary">{t('gatewayChannels.platformSummary', { count: connections.length, bound })}</span>
            </summary>
            <div className="max-h-96 space-y-2 overflow-y-auto overscroll-contain border-t border-border p-2">
              {connections.map(row => {
                const chats = inventory?.chats.filter(chat => chat.connectionId === row.id) ?? []
                const rowBusy = busy.has(row.id)
                const identity = channelConnectionIdentity(row)
                return <details key={row.id} className="group/connection min-w-0 rounded-md border border-border"
                  data-testid="channel-connection-instance" data-connection-id={row.id} aria-busy={rowBusy}>
                  <summary className="flex min-h-11 cursor-pointer list-none items-center gap-2 rounded-md px-3 py-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus [&::-webkit-details-marker]:hidden">
                    <ChevronRight className="h-4 w-4 shrink-0 transition-transform group-open/connection:rotate-90" aria-hidden="true" />
                    <div className="min-w-0 flex-1">
                      <div className="flex min-w-0 items-center justify-between gap-2"><h3 className="truncate font-medium">{row.label}</h3>
                        <span className="shrink-0 text-xs text-text-secondary">{t(`connections.state.${row.state}`)}</span></div>
                      <p className="truncate text-xs text-text-secondary">{typeof identity === 'string' && identity
                        ? t('channelPresentation.identitySuffix', { suffix: identity.slice(-6) }) : t('connections.identityPending')}
                        {' · '}{t('channelPresentation.chatCounts', { count: chats.length, unbound: chats.filter(chat => !chat.binding).length, bound: chats.filter(chat => chat.binding).length })}</p>
                    </div>
                  </summary>
                  <div className="border-t border-border p-3">
                    <div className="flex flex-wrap gap-2">
                      <Button disabled={rowBusy} onClick={() => setEditor({ platform: row.platform, connection: row })}>{t('connections.configure')}</Button>
                      {row.enabled ? <Button disabled={rowBusy} onClick={() => void act(row, 'disconnect')}>{t('connections.stop')}</Button>
                        : <Button disabled={rowBusy || !row.hasCredential} onClick={() => void act(row, 'connect')}>{t('connections.connect')}</Button>}
                      <Popconfirm title={t('connections.removeConfirm')} onConfirm={() => act(row, 'remove')}
                        okText={t('connections.remove')} cancelText={t('octop.cancel')} disabled={rowBusy}>
                        <Button danger disabled={rowBusy} data-testid={`channel-remove-${row.id}`}>{t('connections.remove')}</Button>
                      </Popconfirm>
                      <Button aria-expanded={expanded.has(row.id)} onClick={() => setExpanded(previous => {
                        const next = new Set(previous); if (next.has(row.id)) next.delete(row.id); else next.add(row.id); return next
                      })}>{t('chatTasks.observedChats')} ({chats.length})</Button>
                    </div>
                  <dl className="mt-3 flex flex-wrap gap-x-6 gap-y-2 text-sm">
                    <div><dt className="text-text-secondary">{t('connections.connection')}</dt><dd>{t(`connections.state.${row.state}`)}</dd></div>
                    <div><dt className="text-text-secondary">{t('channelPresentation.chats')}</dt><dd>{t('channelPresentation.chatCounts', { count: chats.length, unbound: chats.filter(chat => !chat.binding).length, bound: chats.filter(chat => chat.binding).length })}</dd></div>
                    <div><dt className="text-text-secondary">{t('channelPresentation.addedAt')}</dt><dd><ChannelTime value={row.createdAtMs} /></dd></div>
                  </dl>
                  <ChannelLabelEditor connection={row} onChanged={refreshInventory} />
                  <details className="mt-2 text-sm text-text-secondary"><summary>{t('chatTasks.identity')}</summary>
                    <p className="break-all">{typeof identity === 'string' ? identity : ''}</p><p className="break-all">{row.id} · {row.revision}</p>
                    <p>{t('connections.authentication')}：{t(row.state === 'connected' ? 'connections.authenticated' : row.hasCredential ? 'connections.credentialSaved' : 'octop.authorizationRequired')}</p></details>
                  {expanded.has(row.id) && <ChannelChatList chats={chats} refreshKey={refresh} onChanged={refreshInventory} />}
                  </div>
                </details>
              })}
            </div>
          </details>
        })}
      </div>
      <section data-testid="channel-global-settings" className="border-t border-border pt-4">
        <h2 className="mb-3 font-medium">{t('gatewayChannels.globalSettings')}</h2>
        <section className="mb-6 flex items-start justify-between gap-4 rounded-lg border border-border p-4">
          <div className="min-w-0">
            <h2 id={syncLabelId} className="font-medium">{t('gatewayChannels.clientSync')}</h2>
            <p id={syncDescriptionId} className="mt-1 text-sm text-text-secondary">{t('gatewayChannels.clientSyncDescription')}</p>
          </div>
          <Switch checked={inventory?.settings.mirrorClientTurns === true} disabled={!inventory || busy.size > 0}
            loading={busy.has('settings')} aria-labelledby={syncLabelId} aria-describedby={syncDescriptionId}
            data-testid="channel-client-sync" onChange={value => void saveClientSync(value)} />
        </section>
        {inventory?.settings.toolRestrictions && <ChannelToolRestrictionsNotice
          policy={inventory.settings.toolRestrictions} />}
      </section>
    </div>
    {choosingPlatform && <Modal title={t('connections.add')} open footer={null} onCancel={() => setChoosingPlatform(false)} destroyOnHidden>
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
        {catalogue.map(item => <button key={item.platform} type="button" data-testid={`channel-add-connection-${item.platform}`}
          aria-label={t('connections.addPlatform', { name: t(`gatewayChannels.platform.${item.platform}`) })}
          disabled={!inventory} className="flex min-h-20 flex-col items-center justify-center gap-2 rounded-lg border border-border p-3 text-sm text-text-primary hover:bg-surface-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus" onClick={() => { setChoosingPlatform(false); setEditor({ platform: item.platform }) }}>
          <img src={item.icon} className="h-6 w-6" alt="" />
          <span className="font-medium">{t(`gatewayChannels.platform.${item.platform}`)}</span>
        </button>)}
      </div>
    </Modal>}
    {editor && <ChannelConnectionEditor key={editor.connection?.id ?? editor.platform} {...editor}
      onClose={() => setEditor(null)} onSaved={() => { setEditor(null); setReading(true); setRefresh(value => value + 1) }} />}
  </section>
}
