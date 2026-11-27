import type { ChannelChat, ChannelConnection, ChannelMessagePreview } from '@/kcoder/channels'
import { channelPlatforms } from '@/kcoder/channelPlatforms'

type Translate = (key: string, options?: Record<string, unknown>) => string
export function channelConnectionIdentity(connection: ChannelConnection): string {
  const value = connection.configuration[channelPlatforms[connection.platform].identityField]
  return typeof value === 'string' ? value : ''
}

export function channelChatTitle(chat: ChannelChat, t: Translate) {
  return chat.alias?.trim() || (chat.label !== chat.range.chatId && chat.label.trim())
    || t('channelPresentation.unnamed', { kind: t(`channelPresentation.kind.${chat.range.chatKind === 'private' ? 'private' : 'group'}`), suffix: chat.range.chatId.slice(-6) })
}

export function channelMessageText(message: ChannelMessagePreview, t: Translate) {
  return message.text.trim() || message.attachments.map(item => item.kind === 'image' ? t('channelPresentation.image') : `${t('channelPresentation.file')}${item.filename ? ` ${item.filename}` : ''}`).join(' · ')
    || t('channelPresentation.noText')
}

export function sortChannelChats(chats: ChannelChat[], query = '', filter = 'all') {
  const word = query.trim().toLocaleLowerCase()
  return chats.filter(chat => (filter === 'all' || (filter === 'bound') === !!chat.binding)
    && (!word || [chat.label, chat.alias, chat.range.chatId, chat.lastMessage?.text, chat.lastMessage?.senderName, chat.lastMessage?.senderId, chat.binding?.target.threadId]
      .some(value => value?.toLocaleLowerCase().includes(word))))
    .sort((a, b) => Number(!!a.binding) - Number(!!b.binding)
      || (b.lastMessage?.timestampMs ?? 0) - (a.lastMessage?.timestampMs ?? 0) || a.id.localeCompare(b.id))
}
