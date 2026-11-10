import React from 'react'
import { createRoot } from 'react-dom/client'
import '@/i18n'
import '@/styles/globals.css'
import { OctopSurface } from '@/features/octop/OctopSurface'
import { ChannelConnectionsWorkspace } from '@/features/connectivity/ChannelConnectionsWorkspace'
import type { ChannelAction, ChannelAuthorization, ChannelConnection, ChannelInventory, ChannelChat } from '@/kcoder/channels'
import { WorkbenchContext } from '@/features/workbench/useWorkbench'
import type { WorkbenchContextValue } from '@/features/workbench/workbenchContextTypes'
import type { RuntimeTaskAddress } from '@/types/api'

// Controlled UI-only HTTP fixture. It has no SDK, Native scope, account secret or model.
const query = new URLSearchParams(window.location.search)
const rows: ChannelConnection[] = [1, 2].map(index => ({ id: `feishu-${index}`, platform: 'feishu', label: `测试应用 ${index}`,
  revision: index * 10, configuration: { appId: `cli_fixture_${index}` }, enabled: index === 1 && !query.has('editable'),
  state: index === 1 && !query.has('editable') ? 'connected' : 'stopped', hasCredential: true }))
if (query.has('many')) for (let index = 3; index <= 40; index++) rows.push({ ...rows[1], id: `feishu-${index}`, label: `测试应用 ${index}`, revision: index * 10 })
let settings = { mirrorClientTurns: false, toolRestrictions: { enabled: true, disabledTools: ['AskUserQuestion', 'AskUserQuestionAsync'] } }
const timestamp = Date.UTC(2026, 10, 7, 11, 20)
if (query.has('chats')) for (const row of rows) row.createdAtMs = timestamp
const chats: ChannelChat[] = query.has('chats') ? [0, 1].map(index => ({
  id: `chat-${index}`, connectionId: 'feishu-1', label: index ? '研发讨论群' : 'oc_private_fixture', alias: index ? '开发联调群' : '', aliasRevision: 0,
  range: { platform: 'feishu', connectionId: 'feishu-1', tenantId: 'fixture', chatKind: index ? 'group' : 'private', chatId: index ? 'oc_group_fixture' : 'oc_private_fixture', topicId: null },
  lastMessage: { text: index ? '这个问题已经修好了吗？' : '帮我看看这个项目怎么启动', senderName: index ? '李四' : '张三', senderId: `user-${index}`, timestampMs: timestamp + index * 1000, attachments: [] },
  bindingRevision: index ? 2 : 0, binding: index ? { chatId: `chat-${index}`, revision: 2, boundAtMs: timestamp,
    target: { serverId: 'macmini', workspacePath: '/Users/Admin/Projects/Alpha', threadId: 'original-session' } } : null, deliveries: [],
})) : []
const opened: RuntimeTaskAddress[] = []
const calls: { action: string; id: string; revision?: number; flowId?: string }[] = []
const pending: { id: string; resolve: () => void; reject: () => void }[] = []
const scanned = new Set<string>()
const failedAuthPolls = new Set<string>()
const flows = new Map<string, { platform: string; id: string; state: ChannelAuthorization }>()
declare global {
  interface Window {
    __channelActions: {
      scan: (kind: string) => void
      calls: () => typeof calls
      pending: () => string[]
      finish: (id: string, success: boolean) => void
      opened: () => RuntimeTaskAddress[]
    }
  }
}
window.__channelActions = {
  opened: () => [...opened],
  scan: kind => { scanned.add(kind) }, calls: () => [...calls], pending: () => pending.map(row => row.id),
  finish: (id, success) => {
    const index = pending.findIndex(row => row.id === id)
    if (index < 0) throw new Error('No pending fixture operation')
    const [operation] = pending.splice(index, 1); success ? operation.resolve() : operation.reject()
  },
}
const originalFetch = window.fetch.bind(window)
window.fetch = async (input, options) => {
  const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
  if (new URL(url, location.href).pathname.endsWith('/api/servers')) return Response.json({ servers: [{ id: 'macmini', runtime: 'kcoder', transport: 'local', label: 'Mac mini' }] })
  if (!new URL(url, location.href).pathname.endsWith('/api/channels')) return originalFetch(input, options)
  if (options?.method !== 'POST') {
    const chatId = new URL(url, location.href).searchParams.get('chatId')
    if (chatId) {
      const chat = chats.find(row => row.id === chatId)
      if (!chat) return Response.json({ code: 'CHANNEL_CHAT_NOT_FOUND' }, { status: 404 })
      return Response.json({ chatId: chat.id, bindingRevision: chat.bindingRevision, messages: chat.lastMessage ? [{ ...chat.lastMessage, id: `input-${chat.id}`, state: chat.binding ? 'completed' : 'unbound' }] : [],
        bindingInfo: chat.binding ? query.has('legacyBinding') && chat.binding.target.threadId === 'original-session'
          ? { revision: chat.bindingRevision, status: 'unavailable', code: 'CHANNEL_TASK_WORKSPACE_MISMATCH' }
          : { revision: chat.bindingRevision, status: 'available', title: chat.binding.target.threadId === 'replacement-session' ? '当前工作区会话' : '修复登录问题', serverLabel: 'Mac mini' } : null })
    }
    const value: ChannelInventory = { installationId: 'browser-fixture', settings, connections: structuredClone(rows), chats: structuredClone(chats) }
    return Response.json(value)
  }
  const body = JSON.parse(String(options.body)) as ChannelAction
  const id = 'connectionId' in body ? body.connectionId : 'connection' in body ? body.connection.id : 'flowId' in body ? body.flowId : 'chatId' in body ? body.chatId : ''
  calls.push({ action: body.action, id, ...('flowId' in body ? { flowId: body.flowId } : {}),
    ...('expectedRevision' in body ? { revision: body.expectedRevision } : {}) })
  if (body.action === 'settings') { settings = { ...settings, ...body.settings }; return Response.json(settings) }
  if (body.action === 'authorization_begin') {
    if (flows.has(body.flowId)) return Response.json(flows.get(body.flowId)!.state)
    const state: ChannelAuthorization = { flowId: body.flowId, state: 'waiting', intervalMs: 50, ...(body.platform === 'weixin' ? { verificationKind: 'image' as const } : {}), verificationUrl: body.platform === 'weixin' ? "data:image/png;base64,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" : 'https://accounts.feishu.cn/fixture' }
    flows.set(body.flowId, { platform: body.platform, id: body.connectionId, state }); return Response.json(state)
  }
  if (body.action === 'authorization_poll' || body.action === 'authorization_read') {
    const flow = flows.get(body.flowId)!
    if (body.action === 'authorization_poll' && query.has('authNetworkFailure') && !failedAuthPolls.has(body.flowId)) {
      failedAuthPolls.add(body.flowId)
      return Response.json({ code: 'WEIXIN_QR_NETWORK_UNAVAILABLE' }, { status: 409 })
    }
    if (scanned.has(flow.platform)) { flow.state.state = 'ready'; delete flow.state.verificationUrl }
    return Response.json(flow.state)
  }
  if (body.action === 'authorization_cancel') return Response.json({ flowId: body.flowId, state: 'cancelled' })
  if (body.action === 'authorization_commit') {
    const flow = flows.get(body.flowId)!
    rows.push({ id: flow.id, platform: flow.platform as ChannelConnection['platform'], label: body.label,
      configuration: { features: body.features }, enabled: false, hasCredential: true, revision: 1, state: 'stopped' })
    return Response.json({ flowId: body.flowId, state: 'saved', connection: { id: flow.id, revision: 1 } })
  }
  if (query.has('controlled')) await new Promise<void>((resolve, reject) => pending.push({ id, resolve, reject: () => reject(new TypeError('Fixture lost response')) }))
  const row = rows.find(item => item.id === id)
  if (body.action === 'bind') {
    const chat = chats.find(item => item.id === body.chatId)!
    if (chat.bindingRevision !== body.expectedBindingRevision) return Response.json({ code: 'CHANNEL_BINDING_CHANGED' }, { status: 409 })
    chat.bindingRevision++
    chat.binding = { chatId: chat.id, target: body.target, revision: chat.bindingRevision }
    return Response.json(chat.binding)
  }
  if (body.action === 'rename_connection') { row!.label = body.label; row!.revision++; return Response.json(row) }
  if (body.action === 'rename_chat') {
    const chat = chats.find(item => item.id === id)!; chat.alias = body.alias; chat.aliasRevision = (chat.aliasRevision ?? 0) + 1
    return Response.json(chat)
  }
  if (body.action === 'remove') {
    rows.splice(rows.findIndex(item => item.id === id), 1); return Response.json({ removed: true })
  }
  if (body.action === 'save') {
    const saved: ChannelConnection = { ...body.connection, enabled: false, state: 'stopped', hasCredential: !!body.credentials || !!row?.hasCredential, revision: (row?.revision ?? 0) + 1 }
    if (row) rows[rows.indexOf(row)] = saved; else rows.push(saved)
    return Response.json(saved)
  }
  if (body.action === 'connect' || body.action === 'disconnect') {
    row!.revision++; row!.enabled = body.action === 'connect'; row!.state = body.action === 'connect' ? 'connected' : 'stopped'
    return Response.json(row)
  }
  return Response.json({ code: 'FIXTURE_ACTION_UNSUPPORTED' }, { status: 409 })
}
const workbench = { state: { runtimeWork: { projects: [], totalTasks: 1, chats: [{ deviceId: 'macmini', deviceName: 'Mac mini',
  available: true, workspacePath: '/Users/Admin/Projects/Current', tasks: [{ taskId: 'kcoder:macmini:replacement-session', threadId: 'replacement-session',
    runtime: 'kcoder', title: '当前工作区会话', workspacePath: '/Users/Admin/Projects/Current' }] }] } },
  openRuntimeTask: async (address: RuntimeTaskAddress) => { opened.push(address) } } as unknown as WorkbenchContextValue
createRoot(document.getElementById('root')!).render(<React.StrictMode><WorkbenchContext.Provider value={workbench}>
  <OctopSurface><div className="p-5"><ChannelConnectionsWorkspace /></div></OctopSurface>
</WorkbenchContext.Provider></React.StrictMode>)
