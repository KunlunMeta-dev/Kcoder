import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, expect, it, vi } from 'vitest'
import type { ReactNode } from 'react'
import type { RuntimeWorkListResponse } from '@/types/api'
import { newExpert, type ExpertClient } from './client'
import { ExpertConversationShell } from './ExpertConversationShell'

const fixture = vi.hoisted(() => ({
  work: null as RuntimeWorkListResponse | null,
  client: null as ExpertClient | null,
  refresh: vi.fn().mockResolvedValue(undefined),
}))
vi.mock('@/features/workbench/useWorkbench', () => ({ useWorkbench: () => ({
  state: { runtimeWork: fixture.work }, refreshWorkLists: fixture.refresh,
}) }))
vi.mock('@/hooks/useTranslation', () => ({ useTranslation: () => ({
  t: (key: string) => key, i18n: { language: 'en' },
}) }))
vi.mock('@/kcoder/usePluginTargetScope', () => ({ usePluginTargetScope: () => ({
  key: 'owned-target', isCurrent: () => true,
}) }))
vi.mock('./ExpertTarget', () => ({ ExpertTarget: ({ children }: { children: (client: ExpertClient) => ReactNode }) => children(fixture.client!) }))
vi.mock('./ExpertConversationActions', () => ({ ExpertConversationActions: () => null }))

beforeEach(() => {
  fixture.refresh.mockClear()
  const owner = { accountId: 'account', targetId: 'target', workspaceId: null }
  const first = { ...newExpert('en'), id: 'first', title: 'First expert' }
  const second = { ...newExpert('en'), id: 'second', title: 'Second expert' }
  fixture.client = { list: vi.fn().mockResolvedValue({ items: [first, second].map(definition => ({ definition, builtin: false })), nextCursor: null }) } as unknown as ExpertClient
  const task = (id: string, expertId: string, channelId?: string) => ({
    taskId: id, threadId: id, title: id, runtimeHandle: {
      agentDefinition: { owner, definition: { id: expertId, version: '1', definitionSha256: 'a'.repeat(64) },
        title: expertId, source: channelId ? 'channel' : 'expert', ...(channelId ? { sourceId: channelId } : {}) },
      ...(channelId ? { channelTaskSource: { owner, channelId } } : {}),
    },
  })
  fixture.work = { projects: [], chats: [{ deviceId: 'local', workspacePath: '/owned', threadsComplete: true,
    tasks: [task('Feishu original messages', 'first', 'feishu-original'), task('Local messages', 'first'), task('Other expert messages', 'second')] }] } as unknown as RuntimeWorkListResponse
  window.history.replaceState({}, '', '/expert-conversations?deviceId=local&workspacePath=%2Fowned&expertId=first&channelId=feishu-original&taskId=Feishu+original+messages')
})

it('shows channel sessions inside their expert and switches to a local sibling without retaining the channel filter', async () => {
  render(<ExpertConversationShell active><div>Original Native transcript owner</div></ExpertConversationShell>)
  const channel = await screen.findByRole('button', { name: /Feishu original messages/ })
  expect(channel).toHaveTextContent('channelTitle')
  expect(channel.closest('[data-channel-id]')).toHaveAttribute('data-channel-id', 'feishu-original')
  fireEvent.click(screen.getByRole('button', { name: 'Local messages' }))
  expect(new URLSearchParams(window.location.search).get('expertId')).toBe('first')
  expect(new URLSearchParams(window.location.search).has('channelId')).toBe(false)
  expect(new URLSearchParams(window.location.search).get('taskId')).toBe('Local messages')
  fireEvent.click(channel)
  expect(new URLSearchParams(window.location.search).get('channelId')).toBe('feishu-original')
})

it('keeps sibling experts discoverable when entered from a channel deep link', async () => {
  render(<ExpertConversationShell active><div /></ExpertConversationShell>)
  fireEvent.click(await screen.findByRole('button', { name: 'Second expert' }))
  await waitFor(() => expect(new URLSearchParams(window.location.search).get('taskId')).toBe('Other expert messages'))
  expect(new URLSearchParams(window.location.search).get('expertId')).toBe('second')
  expect(new URLSearchParams(window.location.search).has('channelId')).toBe(false)
  expect(screen.getByRole('button', { name: 'Other expert messages' })).toBeInTheDocument()
})
