import type { ChannelInventory, ChannelPlatform, ChannelTarget } from './channels'

export const channelTarget: ChannelTarget = { serverId: 'original-target', workspacePath: '/owned/workspace', threadId: 'original-task' }
export function channelFixture(platform: ChannelPlatform = 'feishu'): ChannelInventory {
  return { installationId: 'fixture-gateway', settings: { mirrorClientTurns: false }, connections: [{ id: 'connection', platform, label: 'Original connection',
    configuration: {}, enabled: true, revision: 1, hasCredential: true, state: 'connected' }], chats: [{
    id: 'observed-chat', connectionId: 'connection', label: 'Observed chat',
    range: { platform, connectionId: 'connection', tenantId: 'tenant', chatKind: 'private', chatId: 'platform-chat', topicId: null },
    bindingRevision: 0, binding: null, deliveries: [],
  }] }
}
