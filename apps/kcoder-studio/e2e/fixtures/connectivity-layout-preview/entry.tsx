import { useState } from 'react'
import { createRoot } from 'react-dom/client'
import { createInstance } from 'i18next'
import { I18nextProvider, initReactI18next } from 'react-i18next'
import { TaskCapabilityScopeSelector } from '../../../renderer/src/features/connectivity/TaskCapabilityScopeSelector'
import { TaskCapabilityScopePicker } from '../../../renderer/src/features/connectivity/TaskCapabilityScopePicker'
import taskCapabilityScope from '../../../renderer/src/i18n/locales/zh-CN/taskCapabilityScope.json'
import connectivity from '../../../renderer/src/i18n/locales/zh-CN/connectivity.json'
import { ChannelConnectionsWorkspace } from '../../../renderer/src/features/connectivity/ChannelConnectionsWorkspace'
import '../../../renderer/src/styles/globals.css'

const i18n = createInstance()
await i18n.use(initReactI18next).init({ lng: 'zh-CN', resources: { 'zh-CN': { translation: {}, taskCapabilityScope, connectivity } } })
const realFetch = window.fetch.bind(window)
window.fetch = async (input, options) => {
  const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
  if (!new URL(url, location.href).pathname.endsWith('/api/channels')) return realFetch(input, options)
  if (options?.method === 'POST') throw new Error('LAYOUT_PREVIEW_HAS_NO_MUTATING_PROVIDER')
  return Response.json({ installationId: 'layout-preview', connections: [{ id: 'fixture-qq', platform: 'qq',
    revision: 1, label: '示例 QQ', enabled: true, hasCredential: true, state: 'connected', configuration: {} }], chats: [] })
}
function SavedSourcePreview() {
  const [selected, setSelected] = useState(false)
  const snapshot = { threadId: 'preview-original-thread', revision: 4, selection: { mode: 'none' as const, sources: [] }, effectiveSources: [], effectiveFrom: 'current_snapshot' as const }
  const target = { initialAttempt: { threadId: snapshot.threadId, turnId: 'preview-original-turn', attemptId: 'preview-original-attempt' } }
  return <main className="min-h-screen bg-background px-5 py-6 text-text-primary">
    <div className="mx-auto grid max-w-3xl gap-5"><header className="grid gap-2"><p className="text-sm text-text-muted">KCoder Studio / 任务工作台</p><h1 className="text-lg font-medium">任务工具与资源范围</h1><p className="text-sm text-text-secondary">受控界面预览 · 已保存记录为 fixture；未启动任务、连接平台或调用模型。</p></header>
      <TaskCapabilityScopeSelector ownerKey="preview-owner" loadPage={async () => ({ entries: [
        {referenceId:'preview-native-saved-01',target,title:'季度资料整理',detail:'原会话 · 任务工具与资源范围已保存',savedSnapshot:snapshot,observationState:'saved_only',reasonCode:'TASK_CAPABILITY_SCOPE_LIVE_AUTHORITY_NOT_OBSERVED'},
        {referenceId:'preview-native-saved-02',target,savedSnapshot:{...snapshot,revision:6,effectiveFrom:'next_tool_boundary'},title:'运营数据复核',detail:'原会话 · 等待安全边界',observationState:'saved_only',reasonCode:'TASK_CAPABILITY_SCOPE_LIVE_AUTHORITY_NOT_OBSERVED'},
        {referenceId:'preview-native-unknown',target:null,savedSnapshot:null,title:'待核对的范围记录',observationState:'unknown',reasonCode:'TASK_CAPABILITY_SCOPE_SAVED_RECORD_UNREADABLE'},
      ],nextCursor:null,observationState:'saved_only',reasonCode:null})} onChoose={async () => setSelected(true)} />
      {selected && <TaskCapabilityScopePicker ownerKey="preview-owner" snapshot={snapshot} descriptors={[]} catalogState="unknown" onCommit={async () => {throw new Error('PREVIEW_HAS_NO_MUTATING_NATIVE_PROVIDER')}} />}
    </div>
  </main>
}
createRoot(document.getElementById('root')!).render(
  <I18nextProvider i18n={i18n}>
    {new URLSearchParams(window.location.search).has('task-sources') ? <SavedSourcePreview /> : new URLSearchParams(window.location.search).has('channel-cards') ? <main className="min-h-screen bg-background text-text-primary"><div className="border-b border-border px-7 py-4 text-sm text-text-secondary">通讯渠道 · 界面预览，示例数据，未连接真实平台</div><div className="mx-auto max-w-6xl"><ChannelConnectionsWorkspace /></div></main> : <main className="min-h-screen bg-background text-text-primary">
      <div className="border-b border-border px-7 py-4 text-sm text-text-secondary">KCoder Studio <span className="mx-3 text-text-muted">/</span> 应用与通讯渠道</div>
      <div className="mx-7 mt-5 rounded-lg border border-border bg-surface px-4 py-3 text-sm text-text-secondary" data-testid="layout-preview-note">布局预览 · 尚未连接任何真实平台；配置按钮仅展示界面。</div>
      <ChannelConnectionsWorkspace />
    </main>}
  </I18nextProvider>,
)
