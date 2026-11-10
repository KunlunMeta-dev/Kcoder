import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { Button } from '@/components/ui/button'
import { ModalDialog } from '@/components/ui/modal-dialog'
import { SettingsSelect } from '@/components/settings/SettingsSelect'
import { useTranslation } from '@/hooks/useTranslation'
import { usePluginTargetScope } from '@/kcoder/usePluginTargetScope'
import { channelAction, channelInventory, ChannelRequestError, sameChannelTask,
  type ChannelChat, type ChannelInventory, type ChannelTarget } from '@/kcoder/channels'
import type { RuntimeTaskAddress } from '@/types/api'
import { runtimeThreadId } from '@/lib/runtime-thread-id'
import { TaskDeliveryList } from './TaskDeliveryList'
import { ChannelChatSummary } from './ChannelChatSummary'
import { sortChannelChats, channelConnectionIdentity } from './channelPresentation'

const alwaysCurrent = () => true

export function TaskChannelBindingDialog({ address, onClose, action = 'bind', onlyChatId, onBound, taskLabel }: {
  address: RuntimeTaskAddress
  onClose: () => void
  action?: 'bind' | 'unbind'
  onlyChatId?: string
  onBound?: () => void
  taskLabel?: string
}) {
  const { t } = useTranslation('connectivity')
  const threadId = runtimeThreadId(address)
  const scope = usePluginTargetScope(address.deviceId, address.workspacePath ?? undefined)
  const closeOnNavigation = useRef(onClose)
  useLayoutEffect(() => { closeOnNavigation.current = onClose }, [onClose])
  useEffect(() => {
    const close = () => closeOnNavigation.current()
    window.addEventListener('popstate', close)
    return () => window.removeEventListener('popstate', close)
  }, [])
  return (
    <ModalDialog title={t(action === 'unbind' ? 'chatTasks.unbind' : 'chatTasks.bindTask')}
      testId="task-channel-binding-dialog" onClose={onClose} closeLabel={t('chatTasks.close')} wide>
      {taskLabel && <p className="break-words pt-3 font-medium">{taskLabel}</p>}
      {threadId && address.workspacePath ? (
        <TaskBindingPicker key={JSON.stringify([scope.key, threadId])}
          target={{ serverId: address.deviceId, workspacePath: address.workspacePath, threadId }}
          isCurrent={scope.isCurrent} action={action} onlyChatId={onlyChatId} onBound={onBound} />
      ) : <p role="alert">{t('chatTasks.persistedRequired')}</p>}
    </ModalDialog>
  )
}

/** Chat/task routing uses the Gateway's ordinary login, without a second authorization flow. */
interface TaskBindingPickerProps {
  target: ChannelTarget
  isCurrent?: () => boolean
  action?: 'bind' | 'unbind'
  onlyChatId?: string
  onBound?: () => void
}
export function TaskBindingPicker(props: TaskBindingPickerProps) {
  return <OwnedTaskBindingPicker key={JSON.stringify([props.target, props.onlyChatId])} {...props} />
}
function OwnedTaskBindingPicker({ target, isCurrent = alwaysCurrent, action = 'bind', onlyChatId, onBound }: TaskBindingPickerProps) {
  const { t } = useTranslation('connectivity')
  const [inventory, setInventory] = useState<ChannelInventory | null>(null)
  const [connectionId, setConnectionId] = useState('')
  const [selected, setSelected] = useState('')
  const [after, setAfter] = useState(0)
  const [query, setQuery] = useState('')
  const [busy, setBusy] = useState(false)
  const [reading, setReading] = useState(true)
  const [error, setError] = useState('')
  const [code, setCode] = useState('')
  const [notice, setNotice] = useState('')
  const [confirm, setConfirm] = useState<{ kind: 'bind' | 'unbind'; chat: ChannelChat } | null>(null)
  const [refresh, setRefresh] = useState(0)
  const owner = useRef<AbortController | null>(null)
  const mutation = useRef(false)
  const current = () => !!owner.current && !owner.current.signal.aborted && isCurrent()
  useEffect(() => {
    const lifetime = new AbortController()
    owner.current = lifetime
    let readingNow = false
    const read = async () => {
      if (readingNow || mutation.current || lifetime.signal.aborted || !isCurrent()) return
      readingNow = true
      try {
        const result = await channelInventory(lifetime.signal)
        if (lifetime.signal.aborted || !isCurrent()) return
        setInventory(result); setError(''); setCode('')
      } catch (error) {
        if (!lifetime.signal.aborted && isCurrent()) {
          setInventory(null); setError('chatTasks.unavailable')
          setCode(error instanceof ChannelRequestError ? error.code : '')
        }
      } finally {
        readingNow = false
        if (!lifetime.signal.aborted && isCurrent()) setReading(false)
      }
    }
    void read()
    const poll = () => { if (document.visibilityState !== 'hidden') void read() }
    const timer = window.setInterval(poll, 10000)
    document.addEventListener('visibilitychange', poll)
    return () => {
      lifetime.abort(); window.clearInterval(timer)
      document.removeEventListener('visibilitychange', poll)
      if (owner.current === lifetime) owner.current = null
    }
  }, [isCurrent, refresh])
  const bound = inventory?.chats.filter(chat => (!onlyChatId || chat.id === onlyChatId) && sameChannelTask(chat.binding?.target, target)) ?? []
  const chats = onlyChatId ? inventory?.chats.filter(chat => chat.id === onlyChatId) ?? []
    : sortChannelChats(inventory?.chats.filter(chat => chat.connectionId === connectionId) ?? [], query)
  const chat = chats.find(row => row.id === (onlyChatId ?? selected))
  const connectionLabel = (id: string) => inventory?.connections.find(row => row.id === id)?.label ?? id
  const mutate = async (kind: 'bind' | 'unbind', selectedChat: ChannelChat) => {
    if (!current() || mutation.current || !inventory) return
    mutation.current = true; setBusy(true); setError(''); setCode(''); setNotice('')
    const signal = owner.current!.signal
    try {
      await channelAction(kind === 'bind'
        ? { action: 'bind', chatId: selectedChat.id, target, expectedBindingRevision: selectedChat.bindingRevision }
        : { action: 'unbind', chatId: selectedChat.id, expectedBindingRevision: selectedChat.bindingRevision }, signal)
      if (!current() || signal.aborted) return
      if (kind === 'bind' && onBound) { onBound(); return }
      const result = await channelInventory(signal)
      if (!current() || signal.aborted) return
      setInventory(result); setConfirm(null)
      setNotice(kind === 'bind' ? 'chatTasks.boundSucceeded' : 'chatTasks.unboundSucceeded')
    } catch (error) {
      if (current() && !signal.aborted) {
        setError(error instanceof ChannelRequestError && error.uncertain ? 'chatTasks.unconfirmed' : 'chatTasks.operationFailed')
        setCode(error instanceof ChannelRequestError ? error.code : '')
        setConfirm(null)
      }
    } finally {
      mutation.current = false
      if (current() && !signal.aborted) setBusy(false)
    }
  }
  return (
    <div className="space-y-4 pt-3" data-testid="task-binding-picker" aria-busy={busy}>
      <p className="text-sm text-text-secondary">{t('chatTasks.bindHint')}</p>
      {(error || notice) && <p role={error ? 'alert' : 'status'}>{t(error || notice)}</p>}
      {code && <details className="text-sm text-text-secondary"><summary>{t('chatTasks.deliveries.code')}</summary><code>{code}</code></details>}
      <div className="flex justify-end">
        <Button variant="ghost" size="sm" disabled={busy || reading} onClick={() => { setReading(true); setRefresh(value => value + 1) }}>
          {t('octop.refresh')}
        </Button>
      </div>
      {reading && !inventory ? <p role="status">{t('chatTasks.loading')}</p> : inventory && <>
        <section className="space-y-2">
          <h3 className="font-medium">{t('chatTasks.currentBinding')}</h3>
          {!bound.length ? <p className="text-sm text-text-secondary">{t('chatTasks.noCurrentBinding')}</p> : bound.map(row => (
            <div key={row.id} className="min-w-0 space-y-3 rounded-lg border border-border p-3">
              <div className="flex min-w-0 items-center justify-between gap-3"><div className="min-w-0"><p className="truncate">{connectionLabel(row.connectionId)}</p>
                <ChannelChatSummary chat={row} /></div>
                <Button variant="ghost" disabled={busy} onClick={() => setConfirm({ kind: 'unbind', chat: row })}>{t('chatTasks.unbind')}</Button></div>
              <TaskDeliveryList deliveries={row.deliveries} />
            </div>
          ))}
        </section>
        {action === 'bind' && <>
          {!onlyChatId && <label className="block space-y-2"><span>{t('chatTasks.connection')}</span>
            <SettingsSelect value={connectionId} aria-label={t('chatTasks.connection')} disabled={busy}
              onChange={event => { setConnectionId(event.target.value); setSelected(''); setQuery(''); setAfter(0); setConfirm(null) }}>
              <option value="">{t('chatTasks.chooseConnection')}</option>
              {inventory.connections.map(row => <option key={row.id} value={row.id}>{row.label} · {t(`gatewayChannels.platform.${row.platform}`)}
                {channelConnectionIdentity(row) ? ` · ${t('channelPresentation.identitySuffix', { suffix: channelConnectionIdentity(row).slice(-6) })}` : ''}</option>)}
            </SettingsSelect>
          </label>}
          {(connectionId || onlyChatId) && <section className="space-y-2">
            <h3 className="font-medium">{t('chatTasks.observedChats')}</h3>
            {!onlyChatId && <input className="min-h-11 w-full rounded-md border border-border bg-surface px-3 text-sm" aria-label={t('channelPresentation.search')}
              placeholder={t('channelPresentation.search')} value={query} onChange={event => { setQuery(event.target.value); setSelected(''); setAfter(0); setConfirm(null) }} />}
            {!chats.length ? <p className="text-sm text-text-secondary">{t('chatTasks.empty')}</p> : (
              <div className="max-h-64 space-y-2 overflow-y-auto overscroll-contain">
                {chats.slice(after, after + 10).map(row => (
                  <label key={row.id} className="flex min-w-0 cursor-pointer items-start gap-3 rounded-lg border border-border p-3 text-sm">
                    <input type="radio" name="channel-chat" value={row.id} checked={(onlyChatId ?? selected) === row.id} disabled={busy || !!onlyChatId}
                      onChange={() => { setSelected(row.id); setConfirm(null) }} />
                    <div className="min-w-0 flex-1"><ChannelChatSummary chat={row} />
                      {row.binding && !sameChannelTask(row.binding.target, target) && <p className="mt-1 break-words text-xs text-text-secondary">
                        {row.binding.target.serverId} › {row.binding.target.workspacePath} · {row.binding.target.threadId.slice(-8)}</p>}
                    </div>
                  </label>
                ))}
              </div>
            )}
            <div className="flex justify-end gap-2">
              {after > 0 && <Button variant="ghost" size="sm" onClick={() => setAfter(value => Math.max(0, value - 10))}>{t('chatTasks.previous')}</Button>}
              {after + 10 < chats.length && <Button variant="ghost" size="sm" onClick={() => setAfter(value => value + 10)}>{t('chatTasks.next')}</Button>}
            </div>
            <Button disabled={busy || !chat || sameChannelTask(chat.binding?.target, target)} onClick={() => {
              if (chat?.binding) setConfirm({ kind: 'bind', chat })
              else if (chat) void mutate('bind', chat)
            }}>{t('chatTasks.bindTask')}</Button>
          </section>}
        </>}
      </>}
      {confirm && <div role="alert" className="space-y-3 rounded-lg border border-border p-3">
        <p>{t(confirm.kind === 'unbind' ? 'chatTasks.unbindConfirm' : 'chatTasks.switchConfirm')}</p>
        <div className="flex justify-end gap-2">
          <Button variant="ghost" disabled={busy} onClick={() => setConfirm(null)}>{t('chatTasks.cancel')}</Button>
          <Button disabled={busy} onClick={() => void mutate(confirm.kind, confirm.chat)}>{t('chatTasks.confirm')}</Button>
        </div>
      </div>}
    </div>
  )
}
