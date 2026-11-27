import { describe, expect, it } from 'vitest'
import type { RuntimeTaskSummary, RuntimeWorkListResponse } from '@/types/api'
import {
  expertConversationTasks, expertTaskChannelId, expertTaskConversationScope,
} from './expertTaskProjection'
import { expertConversationRoute, readExpertConversationScope } from './conversationRoutes'
import { parseRuntimeTaskRoute } from '@/lib/navigation'

const owner = { accountId: 'owner', targetId: 'target', workspaceId: null }
const definition = { id: 'personal.expert', version: '1', definitionSha256: 'a'.repeat(64) }
const task = (id: string, runtimeHandle = {}): RuntimeTaskSummary =>
  ({ taskId: id, threadId: id, title: id, runtimeHandle }) as RuntimeTaskSummary
const ordinary = task('ordinary')
const expert = task('expert', {
  agentDefinition: { owner, definition, title: 'Expert', source: 'expert' },
})
const channel = task('channel', { channelTaskSource: { owner, channelId: 'original-feishu' } })
const boundChannel = task('bound-channel', {
  agentDefinition: { owner, definition, title: 'Expert', source: 'channel', sourceId: 'expert-feishu' },
  channelTaskSource: { owner, channelId: 'expert-feishu' },
})
const space = { deviceId: 'local', workspacePath: '/workspace', tasks: [ordinary, expert, channel] }
const work = {
  chats: [space],
  projects: [{ project: { key: 'project' }, deviceWorkspaces: [space] }],
} as RuntimeWorkListResponse

describe('original expert conversation projection', () => {
  it('finds and deduplicates original threads under the correct expert, target and workspace', () => {
    const scope = { deviceId: 'local', workspacePath: '/workspace', expertId: definition.id }
    expect(expertConversationTasks(work, scope).map(({ task }) => task.taskId)).toEqual(['expert'])
    expect(expertConversationTasks(work, { ...scope, deviceId: 'other' })).toEqual([])
    expect(expertConversationTasks(work, { ...scope, workspacePath: '/other' })).toEqual([])
    expect(expertConversationTasks(work, { ...scope, expertId: 'other' })).toEqual([])
  })
  it('locates channel history even before an expert is associated', () => {
    expect(
      expertConversationTasks(work, {
        deviceId: 'local',
        workspacePath: '/workspace',
        channelId: 'original-feishu',
      }).map(({ task }) => task.taskId)
    ).toEqual(['channel'])
  })
  it('groups the original bound channel alongside local expert conversations, without rebinding older history', () => {
    const both = { ...work, chats: [{ ...space, tasks: [ordinary, expert, channel, boundChannel] }], projects: [] }
    const scope = { deviceId: 'local', workspacePath: '/workspace', expertId: definition.id }
    expect(expertConversationTasks(both, scope).map(({ task }) => task.taskId)).toEqual(['expert', 'bound-channel'])
    expect(expertConversationTasks(both, { ...scope, channelId: 'expert-feishu' }).map(({ task }) => task.taskId)).toEqual(['bound-channel'])
    expect(expertTaskChannelId(boundChannel)).toBe('expert-feishu')
  })
  it('derives channel and local links from original task ownership instead of a stale deep-link filter', () => {
    const scope = { deviceId: 'local', workspacePath: '/workspace', expertId: 'other', channelId: 'old-channel' }
    expect(expertTaskConversationScope(scope, boundChannel)).toEqual({ ...scope, expertId: definition.id, channelId: 'expert-feishu' })
    expect(expertTaskConversationScope(scope, expert)).toEqual({ ...scope, expertId: definition.id, channelId: undefined })
    expect(expertTaskConversationScope(scope, channel)).toEqual({ ...scope, expertId: undefined, channelId: 'original-feishu' })
  })
  it('does not manufacture channel ownership from an incomplete handle', () => {
    const malformed = task('ordinary', { channelTaskSource: { channelId: 'not-verified' } })
    expect(expertTaskChannelId(malformed)).toBeUndefined()
  })
  it('restores a public deep link to the exact original thread and workspace', () => {
    const scope = {
      deviceId: 'ssh-target',
      workspacePath: '/workspace space',
      expertId: 'expert/one',
    }
    const url = new URL(
      expertConversationRoute(scope, { deviceId: scope.deviceId, taskId: 'native-original' }),
      'http://localhost'
    )
    expect(readExpertConversationScope(url.search)).toEqual(scope)
    expect(parseRuntimeTaskRoute(url.pathname, url.search)).toEqual({
      deviceId: scope.deviceId,
      taskId: 'native-original',
      workspacePath: scope.workspacePath,
    })
  })
})
