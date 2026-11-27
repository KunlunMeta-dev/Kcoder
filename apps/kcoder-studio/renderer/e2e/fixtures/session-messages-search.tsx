import { useState } from 'react'
import { createRoot } from 'react-dom/client'
import i18n from '../../src/i18n'
import '../../src/styles/globals.css'
import '../../src/styles/disclosures.css'
import { SessionMessagesControl } from '../../src/components/chat/SessionMessagesControl'
import { WorkbenchContext } from '../../src/features/workbench/useWorkbench'
import type { WorkbenchContextValue } from '../../src/features/workbench/workbenchContextTypes'
import { registerGatewayCommandTransport } from '../../src/kcoder/gatewayServiceBridge'
import type { RuntimeTaskAddress } from '../../src/types/api'

// Rendering-only fixture. All records are synthetic; no Native, provider,
// session messages or model turns are created by this page.
await i18n.changeLanguage('zh-CN')
const legacy = new URLSearchParams(location.search).has('legacy')
const requests: Array<{ operation: string; source: string; title?: string; cursor?: string }> = []
let releaseOld: (() => void) | undefined
const evidence = { requests, composerEnterCount: 0, modelCalls: 0, navigationCalls: 0,
  releaseOldSearch() { releaseOld?.() } }
Object.assign(window, { __sessionMessagesSearchFixture: evidence })
const receiver = (id: string, title: string) => ({ address: { targetId: 'synthetic-target', workspaceId: 'synthetic-workspace', threadId: id },
  threadId: id, title, status: 'idle', presence: 'resident', allowedModes: ['enqueue_only'] })
const page = (rows: ReturnType<typeof receiver>[], cursor?: string) => ({ coverage: 'workspace_history', completeness: cursor ? 'indexing' : 'complete', observedAtMs: Date.now(), targets: rows, ...(cursor ? { nextCursor: cursor } : {}) })
registerGatewayCommandTransport((command, args) => {
  const envelope = args as { method?: string; params?: Record<string, unknown> }
  if (command !== 'local_executor_request' || envelope.method !== 'runtime.agentMessages.request') throw new Error('Fixture refuses unrelated commands')
  const input = envelope.params ?? {}, source = String((input.address as RuntimeTaskAddress).deviceId)
  const operation = String(input.operation)
  requests.push({ operation, source, ...(typeof input.title === 'string' ? { title: input.title } : {}), ...(typeof input.cursor === 'string' ? { cursor: input.cursor } : {}) })
  if (operation === 'supports') return { scope: source, sourceThreadId: 'source', discovery: true, messages: true, search: !legacy }
  if (operation === 'policyRead') return { enabled: true, wakeIdle: false, revision: 'synthetic-policy-one' }
  if (operation !== 'targets') throw new Error('Fixture refuses mutations and model turns')
  if (input.title === '旧') return new Promise(resolve => { releaseOld = () => resolve(page([receiver('old', '旧结果')])) })
  if (input.title === '新') return page([receiver('new', '新结果')], 'new-results-next')
  if (input.cursor === 'new-results-next') return page([receiver('more', '新结果更多')])
  if (typeof input.title === 'string') return page([receiver('matching', input.title + '会话')])
  return page([receiver('default', source === 'source-two' ? '新来源默认会话' : '默认会话')])
})
const workbench = { async openRuntimeTask() { evidence.navigationCalls++ } } as unknown as WorkbenchContextValue
export function Preview() {
  const [second, setSecond] = useState(false)
  const address = { deviceId: second ? 'source-two' : 'source-one', taskId: second ? 'second-task' : 'first-task', threadId: 'source', workspacePath: '/owned-ui-fixture' }
  return <WorkbenchContext.Provider value={workbench}>
    <main className="min-h-screen bg-background p-4 text-text-primary" onKeyDown={event => { if (event.key === 'Enter') evidence.composerEnterCount++ }}>
      <h1 className="mb-3 text-base font-medium">会话通讯搜索 · 示例数据，不执行任务</h1>
      <div className="flex items-center gap-3"><SessionMessagesControl address={address} />
        <button type="button" className="rounded-md border border-border px-3 py-2 text-sm" data-testid="search-fixture-switch-source" onClick={() => setSecond(true)}>切换示例来源</button></div>
    </main>
  </WorkbenchContext.Provider>
}
createRoot(document.getElementById('root')!).render(<Preview />)
