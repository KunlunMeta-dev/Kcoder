import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { expect, test, vi } from 'vitest'
import '@/i18n'
import type { InlineWidgetHostProps } from '@/features/widgets'
import type { McpAppApi } from '@/kcoder/mcpAppApi'
import type { WidgetRef } from '../../../../../shared/generated/contracts'
import { ConversationWidgetsContext, type ConversationWidgetsValue } from './widgetContext'
import { McpAppWidget } from './McpAppWidget'

const reply = vi.hoisted(() => vi.fn())
vi.mock('@/features/widgets', () => ({
  readWidgetTheme: () => ({ colorScheme: 'light', locale: 'zh-CN' }),
  InlineWidgetHost: (props: InlineWidgetHostProps) => <button onClick={async () => {
    const base = { widget: props.widget, reply, resize: vi.fn() }
    await props.onAppMessage?.({ ...base, message: { jsonrpc: '2.0', id: 1, method: 'ui/initialize', params: { protocolVersion: '2026-01-26', appInfo: { name: 'app' }, appCapabilities: {} } } })
    await props.onAppMessage?.({ ...base, message: { jsonrpc: '2.0', method: 'ui/notifications/initialized' } })
    void props.onAppMessage?.({ ...base, message: { jsonrpc: '2.0', id: 2, method: 'ui/message', params: { role: 'user', content: { type: 'text', text: '追问数据' } } } })
  }}>App request</button>,
}))
const widget: WidgetRef = { widgetId: 'app', threadId: 'thread', turnId: 'turn', attemptId: 'attempt', toolCallId: 'call', revision: 1, title: 'App', summary: 'Summary',
  format: 'html', executionMode: 'isolated_html', libraries: [], bytes: 1, sha256: 'a'.repeat(64), createdAtMs: 1,
  mcpApp: { serverName: 'server', connectionId: 'connection', resourceUri: 'ui://app', mimeType: 'text/html;profile=mcp-app', pluginId: null, toolName: 'overview' } }

test('component messages preserve the existing draft and wait for an explicit user action', async () => {
  let draft = '已有草稿'
  const sendPrompt = vi.fn((text: string) => { draft += `\n\n${text}` })
  const value = { mcpApps: { read: vi.fn(async () => ({ widget, live: false, protocolVersion: '2026-01-26', allowedTools: [], resourcesEnabled: false, toolInput: {}, toolContent: [] })) } as unknown as McpAppApi,
    isCurrent: () => true, sendPrompt, invalidated: false } as unknown as ConversationWidgetsValue
  render(<ConversationWidgetsContext.Provider value={value}><McpAppWidget widget={widget} panelId="owned" loadContent={async () => ''} /></ConversationWidgetsContext.Provider>)
  fireEvent.click(screen.getByRole('button', { name: 'App request' }))
  const add = await screen.findByRole('button', { name: '添加到草稿' })
  expect(sendPrompt).not.toHaveBeenCalled()
  expect(reply.mock.calls.some(([message]) => message.id === 2)).toBe(false)
  fireEvent.click(add)
  expect(draft).toBe('已有草稿\n\n追问数据')
  await waitFor(() => expect(reply).toHaveBeenCalledWith({ jsonrpc: '2.0', id: 2, result: {} }))
  expect(screen.queryByRole('button', { name: '添加到草稿' })).not.toBeInTheDocument()
})
