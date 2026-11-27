import { useEffect, useRef, useState } from 'react'
import { Button, Input } from 'antd'
import { Pencil } from 'lucide-react'
import { useTranslation } from '@/hooks/useTranslation'
import { channelAction, ChannelRequestError, type ChannelChat, type ChannelConnection } from '@/kcoder/channels'

/** Renaming changes presentation only, including while a platform connection is running. */
export function ChannelLabelEditor({ connection, chat, onChanged }: {
  connection?: ChannelConnection; chat?: ChannelChat; onChanged: () => void
}) {
  const { t } = useTranslation('connectivity')
  const [draft, setDraft] = useState<{ value: string; revision: number } | null>(null)
  const [busy, setBusy] = useState(false), [error, setError] = useState(''), [uncertain, setUncertain] = useState(false)
  const owner = useRef<AbortController | null>(null), lock = useRef(false)
  useEffect(() => { const lifetime = new AbortController(); owner.current = lifetime; return () => { lifetime.abort(); owner.current = null } }, [])
  const label = t(chat ? 'channelPresentation.editAlias' : 'channelPresentation.rename')
  const save = async () => {
    if (!draft || !owner.current || lock.current || uncertain) return
    const signal = owner.current.signal
    lock.current = true; setBusy(true); setError('')
    try {
      await channelAction(chat ? { action: 'rename_chat', chatId: chat.id, alias: draft.value.trim(), expectedAliasRevision: draft.revision }
        : { action: 'rename_connection', connectionId: connection!.id, label: draft.value.trim(), expectedRevision: draft.revision }, signal)
      if (!signal.aborted) { setDraft(null); onChanged() }
    } catch (error) {
      if (!signal.aborted) {
        const unknown = error instanceof ChannelRequestError && error.uncertain
        setUncertain(unknown); setError(unknown ? 'gatewayChannels.operationUnknown' : 'octop.failed')
      }
    } finally { lock.current = false; if (!signal.aborted) setBusy(false) }
  }
  return <div className="min-w-0">
    {!draft ? <Button size="small" type="text" icon={<Pencil size={14} />} aria-label={label} title={label} onClick={() => {
      setError(''); setUncertain(false); setDraft({ value: chat ? chat.alias ?? '' : connection!.label,
        revision: chat ? chat.aliasRevision ?? 0 : connection!.revision })
    }}>{label}</Button> : <div className="flex flex-wrap items-center gap-2">
      <Input aria-label={label} maxLength={256} value={draft.value} disabled={busy || uncertain}
        onChange={event => setDraft({ ...draft, value: event.target.value })} onPressEnter={() => void save()} />
      <Button size="small" loading={busy} disabled={busy || uncertain || !chat && !draft.value.trim()} onClick={() => void save()}>{t('octop.save')}</Button>
      <Button size="small" disabled={busy} onClick={() => setDraft(null)}>{t('octop.cancel')}</Button>
    </div>}
    {error && <p role="alert" className="mt-1 text-sm text-destructive">{t(error)}</p>}
  </div>
}
