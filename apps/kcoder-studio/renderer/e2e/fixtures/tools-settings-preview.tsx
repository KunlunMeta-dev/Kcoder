import { createRoot } from 'react-dom/client'
import type { ToolSelectionsResult } from '../../../shared/generated/contracts'
import { ToolSelectionsSettingsPage } from '../../src/components/settings/ToolSelectionsSettingsPage'
import { WorkbenchContext } from '../../src/features/workbench/useWorkbench'
import type { WorkbenchContextValue } from '../../src/features/workbench/workbenchContextTypes'
import { registerGatewayCommandTransport } from '../../src/kcoder/gatewayServiceBridge'
import i18n from '../../src/i18n'
import '../../src/styles/globals.css'

// Rendering-only fixture: real settings component, synthetic catalog and no writes.
await i18n.changeLanguage('zh-CN')
const tools: ToolSelectionsResult['tools'] = [
  {
    name: 'read',
    ui: {
      displayName: '读取文件',
      description: '读取工作区中的文件内容，查看文本、图片与文档。',
      group: 'files',
      icon: 'file',
    },
    available: true,
    supportedModes: ['kcoder', 'kworker'],
    unavailableReason: null,
  },
  {
    name: 'edit',
    ui: {
      displayName: '编辑文件',
      description: '精确替换文件中的指定内容，保留其他已有修改。',
      group: 'files',
      icon: 'file',
    },
    available: true,
    supportedModes: ['kcoder', 'kworker'],
    unavailableReason: null,
  },
  {
    name: 'write',
    ui: {
      displayName: '写入文件',
      description: '创建文件或写入完整内容。',
      group: 'files',
      icon: 'file',
    },
    available: true,
    supportedModes: ['kcoder', 'kworker'],
    unavailableReason: null,
  },
  {
    name: 'bash',
    ui: {
      displayName: '运行命令',
      description: '在当前会话的工作目录执行终端命令。',
      group: 'terminal',
      icon: 'terminal',
    },
    available: true,
    supportedModes: ['kcoder', 'kworker'],
    unavailableReason: null,
  },
  {
    name: 'Grep',
    ui: {
      displayName: '搜索文件内容',
      description: '按关键词或正则表达式检索工作区文件。',
      group: 'search',
      icon: 'search',
    },
    available: true,
    supportedModes: ['kcoder', 'kworker'],
    unavailableReason: null,
  },
  {
    name: 'WebSearch',
    ui: {
      displayName: '搜索网页',
      description: '查找实时网页信息与参考资料。',
      group: 'web',
      icon: 'globe',
    },
    available: true,
    supportedModes: ['kcoder', 'kworker'],
    unavailableReason: null,
  },
  {
    name: 'TaskCreate',
    ui: {
      displayName: '创建任务',
      description: '为多步骤工作创建可持续跟踪的任务。',
      group: 'planning',
      icon: 'checklist',
    },
    available: true,
    supportedModes: ['kcoder', 'kworker'],
    unavailableReason: null,
  },
  {
    name: 'computer',
    ui: {
      displayName: '桌面控制',
      description: '观察桌面并执行键鼠操作。',
      group: 'other',
      icon: 'tool',
    },
    available: false,
    supportedModes: ['kcoder', 'kworker'],
    unavailableReason: '此运行目标未启用桌面控制。',
  },
  {
    name: 'spawn_agent',
    ui: {
      displayName: '派生子代理',
      description: '将范围明确的任务交给子代理执行。',
      group: 'agents',
      icon: 'agent',
    },
    available: true,
    supportedModes: ['kcoder', 'kworker'],
    unavailableReason: null,
  },
  {
    name: 'Workflow',
    ui: {
      displayName: '执行工作流',
      description: '按已保存的流程推进任务并记录结果。',
      group: 'planning',
      icon: 'checklist',
    },
    available: true,
    supportedModes: ['kcoder', 'kworker'],
    unavailableReason: null,
  },
  {
    name: 'show_widget',
    ui: {
      displayName: '交互式可视化',
      description: '在会话内展示可操作的图表与交互内容。',
      group: 'other',
      icon: 'tool',
    },
    available: true,
    supportedModes: ['kworker'],
    unavailableReason: null,
  },
  {
    name: 'tool_search',
    ui: {
      displayName: '发现扩展工具',
      description: '查找已连接的插件和 MCP 工具。',
      group: 'search',
      icon: 'search',
    },
    available: true,
    supportedModes: ['kworker'],
    unavailableReason: null,
  },
  {
    name: 'tool_execute',
    ui: {
      displayName: '调用扩展工具',
      description: '执行已发现且获准使用的扩展能力。',
      group: 'other',
      icon: 'tool',
    },
    available: true,
    supportedModes: ['kworker'],
    unavailableReason: null,
  },
]
const catalog: ToolSelectionsResult = {
  revision: 'a'.repeat(64),
  modes: [
    {
      mode: 'kcoder',
      editable: true,
      allowedTools: ['read', 'edit', 'write', 'bash', 'Grep', 'WebSearch', 'TaskCreate'],
    },
    {
      mode: 'kworker',
      editable: true,
      allowedTools: [
        'read',
        'write',
        'WebSearch',
        'TaskCreate',
        'spawn_agent',
        'Workflow',
        'show_widget',
        'tool_search',
        'tool_execute',
      ],
    },
  ],
  tools,
  total: tools.length,
  truncated: false,
}
registerGatewayCommandTransport((command, args) => {
  if (command !== 'local_executor_request') throw new Error('UI preview allows no native commands')
  const request = args as { method: string; params: { method: string } }
  if (
    request.method === 'runtime.settings.request' &&
    request.params.method === 'settings/tools/selection/read'
  )
    return catalog
  throw new Error('UI preview is read-only: writes and session creation are disabled')
})
const value = {
  state: {
    currentRuntimeTask: null,
    currentProject: null,
    runtimeWork: null,
    selectedDeviceWorkspaceId: null,
    standaloneDeviceId: null,
    standaloneWorkspacePath: null,
  },
} as WorkbenchContextValue
createRoot(document.getElementById('root')!).render(
  <WorkbenchContext.Provider value={value}>
    <main className="min-h-screen bg-background text-text-primary">
      <div className="border-b border-border bg-surface px-6 py-3 text-sm text-text-secondary">
        Studio 工具设置预览 · 示例数据 · 不写入配置，不创建会话
      </div>
      <div className="px-6 py-8">
        <ToolSelectionsSettingsPage />
      </div>
    </main>
  </WorkbenchContext.Provider>
)
