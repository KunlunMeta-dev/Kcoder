import { TaskOverviewStylePreview } from './task-overview-style-preview'
import { PageHeaderStylePreview } from './page-header-style-preview'
import { StorageSettingsPage } from '../../src/components/settings/StorageSettingsPage'
import { TaskBoardStylePreview } from './task-board-style-preview'
import { WikiFileImportControls } from '../../src/features/knowledge/WikiFileImportControls'
import { createRoot } from 'react-dom/client'
import i18n from '../../src/i18n'
import '../../src/styles/globals.css'
import '../../src/styles/disclosures.css'
import { ScheduledTasksPanel } from '../../src/components/chat/ScheduledTasksPanel'
import { NativeRemoteOperationPanel } from '../../src/features/remote-capabilities/NativeRemoteOperationPanel'
import { PluginProxyControl } from '../../src/components/plugins/PluginProxyControl'
import { registerGatewayCommandTransport } from '../../src/kcoder/gatewayServiceBridge'
import type { RuntimeWorkListResponse } from '../../src/types/api'
import type { LocalCodexPluginApi } from '../../src/api/local/codexPlugins'

// Rendering-only fixture: synthetic target data, no native calls or external sends.
await i18n.changeLanguage('zh-CN')
const scope = { accountId: 'preview', targetId: 'local', workspaceId: '/preview', identityGeneration: 'preview', targetRevision: 'preview' }
registerGatewayCommandTransport((command, args) => {
  if (command !== 'local_executor_request') return null
  const request = args as { method: string; params: { method: string; params?: Record<string, unknown> } }
  const method = request.params.method
  if (method === 'diagnostics/storage/read') return {
    configRoot: 'C:\\Users\\preview\\.config\\kcoder', totalBytes: 1632250000, totalFiles: 800,
    buckets: [{ id: 'debug-logs', bytes: 1632087552, files: 746, cleanable: true }, { id: 'turn-snapshots', bytes: 107930, files: 21, cleanable: true }],
    devDebug: { enabled: false, envSet: false, dotenvLines: 0, retentionDays: 7, logBytes: 0, logFiles: 0 },
    credentials: { path: '', present: false, providers: 0, dotenvCredentialLines: 0, keyringAvailable: false, keyringBackend: 'none', keyringProviders: [], plaintextProviders: [] },
  }
  if (method === 'settings/turn-file-changes/read') return null
  if (method === 'integrations/scope/read') return scope
  if (method === 'cron/list') return { jobs: [] }
  if (request.method === 'runtime.workflows.request') return { items: [{ id: 'travel', title: '旅游攻略工作流', status: 'saved', savedVersion: 1 }], truncated: false, total: 1 }
  if (method?.startsWith('settings/integrations/knowledge/')) {
    const flags = { memoryCenterEnabled: true, publicationsEnabled: false, businessAutomationEnabled: true }
    return { effective: flags, connection: flags, persisted: flags, revision: 'a'.repeat(64), restartRequired: false }
  }
  const envelope = request.params.params ?? {}
  return { contractVersion: 'parallel-v1', requestId: envelope.requestId, operationId: envelope.operationId ?? null, entityRevision: null, observedAt: new Date().toISOString(), status: 'completed', result: { page: { items: [], nextCursor: null } }, error: null }
})
const work = { projects: [], totalTasks: 0, chats: [{ deviceId: 'local', workspacePath: '/preview', label: '当前计算机', tasks: [], available: true }] } as RuntimeWorkListResponse
const api = { getProxySettings: async () => ({ autoDetect: true, checkedPorts: 8, checkedCandidates: 1, quickChecks: 0, source: 'scan', targetHosts: ['https://p11-market.byteimg.com'], proxyUrl: null }) } as unknown as LocalCodexPluginApi
createRoot(document.getElementById('root')!).render(
  <main className="min-h-screen bg-background text-text-primary">
    <div className="border-b border-border bg-surface px-6 py-3 text-sm text-text-secondary">Studio 界面验收预览 · 示例数据，不执行任务</div>
    {new URLSearchParams(location.search).get('panel') === 'headers' ? <PageHeaderStylePreview /> : new URLSearchParams(location.search).get('panel') === 'overview' ? <TaskOverviewStylePreview /> : new URLSearchParams(location.search).get('panel') === 'storage' ? <div className="px-5 py-8"><StorageSettingsPage /></div> : new URLSearchParams(location.search).get('panel') === 'board' ? <TaskBoardStylePreview /> : new URLSearchParams(location.search).get('panel') === 'upload' ? <section className="mx-auto max-w-4xl p-6"><WikiFileImportControls busy={false} onFiles={() => {}} onDirectory={() => {}} /></section> : new URLSearchParams(location.search).get('panel') === 'remote-operation' ? <section className="mx-auto max-w-4xl p-6"><NativeRemoteOperationPanel target={{ serverId: 'local', workspacePath: '/preview' }} /></section> : new URLSearchParams(location.search).get('panel') === 'proxy'
      ? <section className="mx-auto max-w-[62.4rem] p-6"><h1 className="mb-6 text-xl font-medium">插件市场 · 网络设置</h1><PluginProxyControl api={api} /></section>
      : <ScheduledTasksPanel runtimeWork={work} />}
  </main>
)
