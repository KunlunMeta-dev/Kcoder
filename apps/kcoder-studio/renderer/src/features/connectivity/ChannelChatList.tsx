import { useContext, useEffect, useRef, useState } from 'react'
import { Button, Input, Segmented } from 'antd'
import { useTranslation } from '@/hooks/useTranslation'
import { channelChatDetails, ChannelRequestError, type ChannelChat, type ChannelChatDetails } from '@/kcoder/channels'
import { WorkbenchContext } from '@/features/workbench/useWorkbench'
import { runtimeTaskId } from '@/kcoder/gateway/runtime/contracts'
import { navigateTo } from '@/lib/navigation'
import { copyTextToClipboard } from '@/lib/clipboard'
import { ChannelChatSummary, ChannelTime } from './ChannelChatSummary'
import { channelMessageText, sortChannelChats } from './channelPresentation'
import { ChannelLabelEditor } from './ChannelLabelEditor'
import { ChannelRebindDialog } from './ChannelRebindDialog'

function ChatRow({ chat, onChanged, refreshKey }: { chat: ChannelChat; onChanged: () => void; refreshKey: number }) {
  const { t } = useTranslation('connectivity'), workbench = useContext(WorkbenchContext)
  const [expanded, setExpanded] = useState(false), [refresh, setRefresh] = useState(0)
  const [result, setResult] = useState<{ key: string; details?: ChannelChatDetails; code?: string } | null>(null)
  const [copyError, setCopyError] = useState(false)
  const [opening, setOpening] = useState(false), [openError, setOpenError] = useState(false)
  const [rebinding, setRebinding] = useState(false)
  const lifetime = useRef<AbortController | null>(null)
  const wantsDetails = expanded || !!chat.binding
  const readKey = JSON.stringify([chat.id, chat.bindingRevision, wantsDetails, refresh, refreshKey])
  const current = result?.key === readKey ? result : null
  const details = current?.details ?? null, reading = wantsDetails && !current
  const error = current?.code || (copyError ? 'CHANNEL_COPY_FAILED' : '')
  useEffect(() => { const owner = new AbortController(); lifetime.current = owner; return () => { owner.abort(); lifetime.current = null } }, [])
  useEffect(() => {
    if (!wantsDetails) return
    const owner = new AbortController()
    void channelChatDetails(chat.id, owner.signal).then(result => {
      if (!owner.signal.aborted) {
        setResult(result.bindingRevision === chat.bindingRevision ? { key: readKey, details: result } : { key: readKey, code: 'CHANNEL_BINDING_CHANGED' })
      }
    }).catch(error => { if (!owner.signal.aborted) setResult({ key: readKey, code: error instanceof ChannelRequestError ? error.code : 'CHANNEL_OPERATION_FAILED' }) })
    return () => owner.abort()
  }, [chat.id, chat.bindingRevision, wantsDetails, readKey])
  const binding = chat.binding, info = details?.bindingInfo
  const mismatch = info?.status === 'unavailable' && info.code === 'CHANNEL_TASK_WORKSPACE_MISMATCH'
  const workspace = binding?.target.workspacePath
  const open = async () => {
    if (!binding || !workbench || opening || !lifetime.current) return
    const signal = lifetime.current.signal; setOpening(true); setOpenError(false)
    try {
      await workbench.openRuntimeTask({ deviceId: binding.target.serverId,
        taskId: runtimeTaskId({ id: binding.target.serverId, runtime: 'kcoder' }, binding.target.threadId),
        threadId: binding.target.threadId, workspacePath: binding.target.workspacePath,
        runtimeHandle: { threadId: binding.target.threadId } })
    } catch { if (!signal.aborted) setOpenError(true) }
    finally { if (!signal.aborted) setOpening(false) }
  }
  return <li className="min-w-0 space-y-3 rounded-lg border border-border p-3 text-sm" data-testid="channel-chat-row">
    <ChannelChatSummary chat={chat} bindingLabel={binding && info?.status !== 'available'
      ? t(mismatch ? 'channelPresentation.workspaceMismatchShort' : info?.status === 'unavailable' || error
        ? 'channelPresentation.targetUnavailableShort' : 'channelPresentation.loadingTask') : undefined} />
    {binding && <div className="min-w-0 rounded-md bg-surface-hover p-2" data-testid="channel-bound-task">
      <div className="flex items-center justify-between gap-2">
        <p className="min-w-0 truncate font-medium">{info?.title || t('channelPresentation.taskFallback', { suffix: binding.target.threadId.slice(-8) })}</p>
        <Button size="small" loading={opening} disabled={!workbench || opening || mismatch} onClick={() => void open()}>{t('channelPresentation.openTask')}</Button>
      </div>
      <p className="break-words text-xs text-text-secondary" title={workspace}>{info?.serverLabel || binding.target.serverId} › {workspace?.split(/[\\/]/).filter(Boolean).at(-1) || t('channelPresentation.workspaceUnknown')}</p>
      {reading && !details && <p role="status" className="text-xs text-text-secondary">{t('channelPresentation.loadingTask')}</p>}
      {info?.status === 'unavailable' && <>
        <p role="status" className="text-xs text-warning">{t(mismatch ? 'channelPresentation.workspaceMismatch' : 'channelPresentation.targetUnavailable')}</p>
        <p className="break-all text-xs text-text-secondary">{t('channelPresentation.bindingWorkspace')}：{workspace || t('channelPresentation.workspaceUnknown')}</p>
      </>}
      {openError && <p role="alert" className="text-xs text-destructive">{t('channelPresentation.openFailed')}</p>}
    </div>}
    <div className="flex flex-wrap items-center gap-2">
      <Button size="small" aria-expanded={expanded} onClick={() => setExpanded(value => !value)}>{t(expanded ? 'channelPresentation.hideMessages' : 'channelPresentation.viewMessages')}</Button>
      <ChannelLabelEditor chat={chat} onChanged={onChanged} />
      {binding && <Button size="small" disabled={!workbench} onClick={() => setRebinding(true)}>{t('channelPresentation.rebind')}</Button>}
      {!binding && <Button size="small" type="text" onClick={() => navigateTo('/tasks')}>{t('channelPresentation.chooseTask')}</Button>}
    </div>
    {expanded && <section className="space-y-2" aria-label={t('channelPresentation.recentMessages')}>
      <div className="flex items-center justify-between"><h4 className="font-medium">{t('channelPresentation.recentMessages')}</h4>
        <Button size="small" disabled={reading} onClick={() => setRefresh(value => value + 1)}>{t('octop.refresh')}</Button></div>
      {reading && <p role="status">{t('chatTasks.loading')}</p>}
      {!reading && details && !details.messages.length && <p className="text-text-secondary">{t('channelPresentation.noMessages')}</p>}
      <ul className="max-h-56 space-y-2 overflow-y-auto overscroll-contain">{details?.messages.map(message => <li key={message.id} className="rounded-md bg-surface-hover p-2">
        <p className="break-words text-xs text-text-secondary">{message.senderName || t('channelPresentation.senderFallback', { suffix: message.senderId.slice(-6) })} · <ChannelTime value={message.timestampMs} /></p>
        <p className="whitespace-pre-wrap break-words">{channelMessageText(message, t)}</p>
        {message.state === 'unbound' && <p className="mt-1 text-xs text-text-secondary">{t('channelPresentation.notSubmitted')}</p>}
      </li>)}</ul>
      <details className="text-xs text-text-secondary"><summary>{t('channelPresentation.identifiers')}</summary>
        <p className="break-all">{chat.range.chatId}{chat.range.topicId ? ` / ${chat.range.topicId}` : ''}</p>
        <Button size="small" onClick={() => { setCopyError(false); void copyTextToClipboard(chat.range.chatId).catch(() => setCopyError(true)) }}>{t('channelPresentation.copyId')}</Button>
        {binding && <><p className="break-all">{binding.target.serverId} · {workspace}</p><p className="break-all">{binding.target.threadId}</p>
          <p>{t('channelPresentation.boundAt')}：<ChannelTime value={binding.boundAtMs} /></p></>}
      </details>
    </section>}
    {error && <p role="alert" className="text-destructive">{t(error === 'CHANNEL_COPY_FAILED' ? 'channelPresentation.copyFailed' : 'channelPresentation.readFailed')} <code>{error}</code></p>}
    {rebinding && <ChannelRebindDialog chat={chat} onClose={() => setRebinding(false)} onChanged={onChanged} />}
  </li>
}

export function ChannelChatList({ chats, onChanged, refreshKey = 0 }: { chats: ChannelChat[]; onChanged: () => void; refreshKey?: number }) {
  const { t } = useTranslation('connectivity')
  const [query, setQuery] = useState(''), [filter, setFilter] = useState('all'), [page, setPage] = useState(0)
  const rows = sortChannelChats(chats, query, filter), currentPage = Math.min(page, Math.max(0, Math.ceil(rows.length / 10) - 1))
  return <section className="my-4 space-y-3 border-t border-border pt-4" data-testid="channel-external-chats">
    <h3 className="font-medium">{t('chatTasks.observedChats')}</h3>
    <p className="text-sm text-text-secondary">{t('channelPresentation.bindingHint')}</p>
    <div className="flex flex-wrap gap-2">
      <Input className="min-w-0 flex-1" aria-label={t('channelPresentation.search')} placeholder={t('channelPresentation.search')}
        value={query} onChange={event => { setQuery(event.target.value); setPage(0) }} />
      <Segmented value={filter} onChange={value => { setFilter(String(value)); setPage(0) }} options={['all', 'unbound', 'bound'].map(value => ({ value, label: t(`channelPresentation.filter.${value}`) }))} />
    </div>
    {!rows.length ? <p className="text-sm text-text-secondary">{t(chats.length ? 'channelPresentation.noMatches' : 'chatTasks.empty')}</p>
      : <ul className="max-h-96 space-y-3 overflow-y-auto overscroll-contain">{rows.slice(currentPage * 10, currentPage * 10 + 10).map(chat =>
        <ChatRow key={`${chat.id}:${chat.bindingRevision}`} chat={chat} refreshKey={refreshKey} onChanged={onChanged} />)}</ul>}
    {rows.length > 10 && <div className="flex justify-end gap-2"><Button size="small" disabled={!currentPage} onClick={() => setPage(currentPage - 1)}>{t('chatTasks.previous')}</Button>
      <Button size="small" disabled={(currentPage + 1) * 10 >= rows.length} onClick={() => setPage(currentPage + 1)}>{t('chatTasks.next')}</Button></div>}
  </section>
}
