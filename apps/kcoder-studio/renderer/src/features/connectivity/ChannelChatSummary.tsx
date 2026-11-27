import { useTranslation } from '@/hooks/useTranslation'
import type { ChannelChat } from '@/kcoder/channels'
import { channelChatTitle, channelMessageText } from './channelPresentation'

export function ChannelTime({ value }: { value?: number | null }) {
  const { t, i18n } = useTranslation('connectivity')
  if (value == null) return <span>{t('channelPresentation.timeUnknown')}</span>
  const date = new Date(value)
  if (!Number.isFinite(date.getTime())) return <span>{t('channelPresentation.timeUnknown')}</span>
  return <time dateTime={date.toISOString()} title={date.toLocaleString(i18n?.language)}>
    {date.toLocaleString(i18n?.language, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })}
  </time>
}

/** The same human-readable identity and latest inbound content are used in both binding entrances. */
export function ChannelChatSummary({ chat, bindingLabel }: { chat: ChannelChat; bindingLabel?: string }) {
  const { t } = useTranslation('connectivity')
  return <div className="min-w-0 space-y-1">
    <div className="flex min-w-0 items-start justify-between gap-3">
      <span className="min-w-0 truncate font-medium" title={channelChatTitle(chat, t)}>{channelChatTitle(chat, t)}</span>
      <span className="shrink-0 text-xs text-text-secondary">{bindingLabel ?? t(chat.binding ? 'chatTasks.bindingState.active' : 'chatTasks.bindingState.unbound')}</span>
    </div>
    <p className="text-xs text-text-secondary">{t(`channelPresentation.kind.${chat.range.chatKind === 'private' ? 'private' : 'group'}`)}
      {chat.lastMessage && <> · <ChannelTime value={chat.lastMessage.timestampMs} /></>}</p>
    {chat.lastMessage && <p className="line-clamp-2 break-words text-text-secondary">
      {chat.lastMessage.senderName && <span>{chat.lastMessage.senderName}： </span>}{channelMessageText(chat.lastMessage, t)}
    </p>}
  </div>
}
