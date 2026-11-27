import { useState } from 'react'
import webSourceExamples from '../../../shared/generated/examples.web-sources.json'
import { normalizeWebSources } from '../../../shared/webSources'
import { createRoot } from 'react-dom/client'
import { MessageList } from '../../src/components/chat/MessageList'
import { applyAppearance } from '../../src/features/appearance/applyAppearance'
import { defaultAppearance } from '../../src/features/appearance/presets'
import { defaultAppPreferences } from '../../src/host/appPreferences'
import { registerGatewayCommandTransport } from '../../src/kcoder/gatewayServiceBridge'
import type { ProcessingBlock, WorkbenchMessage } from '../../src/types/workbench'
import i18n from '../../src/i18n'
import '../../src/styles/globals.css'

// Actual renderer components with synthetic, local-only transcript data.
registerGatewayCommandTransport(async command => {
  if (command === 'get_app_preferences') return defaultAppPreferences
  throw new Error(`Unexpected preview command: ${command}`)
})
await i18n.changeLanguage('zh-CN')
applyAppearance(defaultAppearance, 'light')
const webSources = normalizeWebSources(
  { ...webSourceExamples.WebSourcesToolResultV1.find(value => value.name === 'native-summary')!.value.webSources, toolCallId: 'search-preview' },
  { toolCallId: 'search-preview' }
)!
const start = Date.parse('2026-11-21T08:00:00Z')
type Scene = 'done' | 'running' | 'failed' | 'stopped'
function thinking(id: string, text: string): ProcessingBlock {
  return { id, type: 'thinking', subtaskId: 'preview-attempt', content: text,
    status: 'done', createdAt: start, completedAt: start + 2000 }
}
function tool(id: string, name: string, input: Record<string, unknown>, output: string): ProcessingBlock {
  return { id, type: 'tool', subtaskId: 'preview-attempt', toolName: name,
    toolInput: input, toolOutput: output, status: 'done',
    createdAt: start + 2000, completedAt: start + 5000 }
}
function messages(scene: Scene): WorkbenchMessage[] {
  const assistant = (id: string, content: string, blocks: ProcessingBlock[]): WorkbenchMessage => ({
    id, role: 'assistant', status: 'done', content, blocks,
    turnId: 'preview-turn', attemptId: 'preview-attempt', createdAt: new Date(start).toISOString(),
  })
  const command = tool('command', 'bash', { command: 'find images -maxdepth 2 -type f' },
    'images/画布1.json\nimages/复杂流水线.json\nimages/assets/content.md')
  if (scene === 'running' || scene === 'stopped') { command.status = 'streaming'; command.completedAt = undefined }
  if (scene === 'failed') { command.status = 'error'; command.toolOutput = 'Permission denied: images/private' }
  const last = assistant('second-step', '', [thinking('second-thought', '继续检查目录结构，确认各类文件之间的关系。'), command])
  if (scene === 'running') last.status = 'streaming'
  return [
    { id: 'user', role: 'user', status: 'done', content: '帮我介绍 images 目录里的内容。', createdAt: new Date(start).toISOString() },
    assistant('first-step', '已找到目录，接下来检查文件类型和引用关系。', [
      thinking('first-thought', '先读取目录说明，再确认资源文件和配置文件的用途。'),
      tool('read', 'read', { file_path: 'images/README.md' }, '# images\n存放画布配置、流水线定义与生成的资源文件。'),
      { ...tool('search-preview', 'web_search', { query: 'images reference' }, 'Search result details'), webSources },
    ]),
    last,
    ...(scene === 'stopped' ? [{ ...assistant('stop-marker', '', []), runtimeStatus: 'cancelled' as const,
      createdAt: new Date(start + 95000).toISOString() }] :
    scene === 'running' ? [] : [{ ...assistant('final-answer', scene === 'failed'
      ? '部分目录读取失败，已有结果已保留。请检查 private 目录的权限后再继续。'
      : '这个目录包含三类内容：\n\n- **画布配置**：定义节点、位置和连接关系。\n- **流水线定义**：描述任务步骤与数据流。\n- **资源文件**：保存图片和配套说明。\n\n可以先从 `画布1.json` 和 `复杂流水线.json` 开始阅读。', []), completedAt: start + 90000 }]),
  ]
}
export function Preview() {
  const [scene, setScene] = useState<Scene>('done')
  const [dark, setDark] = useState(false)
  return <main className="min-h-dvh bg-bg-base p-6 text-text-primary">
    <div className="mx-auto max-w-3xl">
      <header className="mb-5 flex flex-wrap items-center justify-between gap-3">
        <div><h1 className="text-lg font-semibold">对话过程 · 当前实现预览</h1>
          <p className="mt-1 text-xs text-text-muted">实际 MessageList 组件 · 示例对话数据</p></div>
        <nav className="flex gap-2">
          {(['done', 'running', 'failed', 'stopped'] as const).map(value => <button key={value}
            className="rounded-md border border-border px-3 py-2 text-sm hover:bg-muted"
            onClick={() => setScene(value)}>{({ done: '已完成', running: '运行中', failed: '工具失败', stopped: '已停止' })[value]}</button>)}
          <button className="rounded-md border border-border px-3 py-2 text-sm hover:bg-muted"
            onClick={() => { setDark(!dark); applyAppearance(defaultAppearance, dark ? 'light' : 'dark') }}>切换主题</button>
        </nav>
      </header>
      <section data-testid="process-preview" className="rounded-xl border border-border bg-bg-surface pb-6">
        <MessageList messages={messages(scene)} conversationKey="visual-preview"
          disableContentVisibility />
      </section>
    </div>
  </main>
}
createRoot(document.getElementById('root')!).render(<Preview />)
