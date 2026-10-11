import { createRoot } from 'react-dom/client'
import i18n from '../../src/i18n'
import '../../src/styles/globals.css'
import examples from '../../../shared/generated/examples.json'
import { readModelConfiguration } from '../../../shared/modelConfiguration'
import { KCoderProviderSettingsPage } from '../../src/components/settings/KCoderProviderSettingsPage'
import { UsageSettingsPage } from '../../src/components/settings/UsageSettingsPage'
import { KnowledgeWorkspace } from '../../src/features/knowledge/KnowledgeWorkspace'
import {
  WorkflowVerification,
  type WorkflowVersionVerification,
} from '../../src/features/workflows/WorkflowVerification'
import { SettingsDialog } from '../../src/components/settings/settings-ui'
import { Button } from '../../src/components/ui/button'
import { WorkbenchContext } from '../../src/features/workbench/useWorkbench'
import type { WorkbenchContextValue } from '../../src/features/workbench/workbenchContextTypes'
import { initialWorkbenchState } from '../../src/features/workbench/workbenchReducer'
import { registerGatewayCommandTransport } from '../../src/kcoder/gatewayServiceBridge'
import { wikiFileCapabilities } from '../../src/features/knowledge/wikiFileCapabilities'
import { KCoderPluginManagementWorkspace } from '../../src/kcoder/KCoderPluginManagementWorkspace'
import { emptyUsage } from '../../src/kcoder/usageHistory'
import { ProcessingWindowFixture } from './processing-window'
import { defaultAppPreferences } from '../../src/tauri/appPreferences'
import { resolveUiTypographyVariables } from '../../src/features/appearance/typography'

// UI-only fixtures use the actual renderer and safe synthetic DTOs. They do not
// substitute for backend, provider, account or native desktop acceptance.
await i18n.changeLanguage('zh-CN')
const query = new URLSearchParams(location.search)
document.documentElement.classList.toggle('dark', query.get('theme') === 'dark')
for (const [key, value] of Object.entries(
  resolveUiTypographyVariables(Number(query.get('fontSize') ?? 14))
)) {
  document.documentElement.style.setProperty(key, value)
}
const configuration = readModelConfiguration({
  ...examples.ModelConfigurationSummary[1].value,
  providerId: 'MiniMax',
  modelId: 'MiniMax-M3.1-Flash-Preview',
  apiFormat: 'anthropic_messages',
  contextWindowTokens: 1048576,
  maxOutputTokens: 100000,
  requestOutputLimits: { max_tokens: 100000 },
  reasoningEffort: 'high',
  sources: { 'tools.profile': ['session_snapshot'] },
  toolSet: { profile: 'full', registryScope: 'session_registry', registeredToolCount: 42 },
})!
const profile = {
  id: 'MiniMax',
  apiFormat: 'anthropic_messages',
  endpoint: 'https://example.invalid/v1',
  model: configuration.modelId,
  contextWindowTokens: 1048576,
  maxOutputTokens: 100000,
  apiKeyConfigured: true,
  isDefault: true,
  authentication: { mode: 'api_key' },
  profileConfiguration: configuration,
  nextTurnConfiguration: configuration,
}
const titles = [
  'SGLang 服务与运行环境',
  '几何图形模板·演示文稿1.pptx · 1-1',
  'MiMo_V2_6_technical_report.pdf · 1-1',
  '预训练、OpenDriveVLA 与 OPD 命令速记',
  'command.txt · 1-1',
  'Megatron RLHF GKD 配置记录',
]
const wikiPagination = query.get('wikiPagination')
const pageTitles = wikiPagination
  ? Array.from({ length: 21 }, (_, index) => `分页知识页面 ${index + 1}`)
  : titles
const sourceTitles = wikiPagination
  ? Array.from({ length: 11 }, (_, index) => `分页原始资料 ${index + 1}`)
  : titles.slice(0, 3)
const pages = pageTitles.map((title, index) => ({
  pageId: `page-${index}`,
  title,
  revisionId: `revision-${index}`,
  kind: 'topic',
  humanEdited: false,
}))
const sources = sourceTitles.map((title, index) => ({
  sourceId: `source-${index}`,
  title,
  revisionId: `revision-${index}`,
  bodyHash: 'synthetic',
}))
function wikiListing<T>(items: T[], id: keyof T, params: Record<string, unknown> = {}) {
  if (!wikiPagination) return { items }
  if (params.limit !== 10) throw new Error('Wiki pagination must request ten items')
  const start = params.afterId ? items.findIndex(item => item[id] === params.afterId) + 1 : 0
  if (params.afterId && start === 0) throw new Error('Unknown Wiki fixture cursor')
  // Keep an oversized batch with a cursor to verify cached overflow joins the next response.
  const size = wikiPagination === 'oversized' && !params.afterId ? 17 : 10
  const batch = items.slice(start, start + size)
  return {
    items: batch,
    nextAfterId: start + batch.length < items.length ? batch.at(-1)![id] : null,
  }
}
const now = Date.UTC(2026, 9, 9, 12)
const days = Object.fromEntries(
  Array.from({ length: 30 }, (_, index) => [
    new Date(now - index * 86400000).toISOString().slice(0, 10),
    Object.fromEntries(
      Array.from({ length: 23 }, (_, model) => [
        `model-${model}`,
        { ...emptyUsage(), requests: 1, inputTokens: 100, outputTokens: 50, totalTokens: 150 },
      ])
    ),
  ])
)
const pluginInventory = [
  [
    'ai-websearch-expert',
    'A multi-engine AI web search plugin integrating multiple search services for real-time information retrieval.',
    ['search', 'web', 'deepseek', 'doubao', 'kimi'],
  ],
  [
    'algorithmic-art',
    '使用 p5.js 创建算法艺术，支持粒子随机性和交互式参数探索。适用于生成艺术、流场、粒子系统等代码艺术创作。',
    ['p5.js', 'creative', 'art', 'generative'],
  ],
  [
    'consensus',
    'Consensus is a research MCP for academic research. Search, synthesize, and build structured research outputs from your conversation.',
    ['research', 'academic', 'paper', 'summarization', 'evidence', 'science'],
  ],
  [
    'development-essentials',
    '核心开发命令集，包含编码、调试、测试、优化和文档生成等常用开发工作流。',
    ['development', 'tools', 'workflow', 'cli'],
  ],
  [
    'dingtalk',
    '通过 CLI 在 KCoder 中使用日历、文档、消息、待办、通讯录等能力。',
    ['productivity', 'communication', 'calendar'],
  ],
  [
    'find-skills',
    '帮助用户发现和安装 AI Agent 技能，支持多个技能仓库的搜索和安装。',
    ['agent', 'skills', 'tools'],
  ],
  [
    'frontend-design',
    '前端设计与开发辅助插件，支持组件生成、页面布局和设计稿转代码。',
    ['frontend', 'design', 'ui', 'component'],
  ],
].map(([name, description, keywords], index) => ({
  id: `${name}@fixture-market`,
  name: String(name),
  description: String(description),
  keywords,
  version: index === 2 ? '4.0.0' : '1.0.0',
  enabled: true,
  root: `/fixture/plugins/${name}`,
  components: [
    { kind: 'skill', name: `${name}-skill`, path: `/fixture/plugins/${name}/SKILL.md` },
    { kind: 'hook', name: 'UserPromptSubmit', path: `/fixture/plugins/${name}/hooks.json` },
  ],
}))
registerGatewayCommandTransport((command, args) => {
  if (command === 'get_app_preferences') return defaultAppPreferences
  if (command !== 'local_executor_request')
    throw new Error(`Unexpected fixture command: ${command}`)
  const request = args as {
    method: string
    params: { method?: string; params?: Record<string, unknown> }
  }
  if (request.method === 'runtime.tools.catalog') return { cachePolicy: 'no-store', tools: [] }
  if (request.method === 'runtime.usage.stats')
    return {
      windowDays: 30,
      timeZone: 'UTC',
      generatedAtMs: now,
      history: { version: 1, trackedSinceMs: now, lastRecordedAtMs: now, days },
    }
  const method = request.params.method
  switch (method) {
    case 'marketplace/list':
      return {
        marketplaces: [
          {
            id: 'fixture-market',
            path: '/fixture/marketplace',
            plugins: pluginInventory.map(plugin => ({
              pluginId: plugin.id,
              version: plugin.version,
              installPolicy: 'AVAILABLE',
              source: {},
              manifestFallback: { keywords: plugin.keywords },
            })),
          },
        ],
        diagnostics: [],
      }
    case 'plugin/list':
      return { plugins: pluginInventory }
    case 'plugin/icon':
      return { url: null }
    case 'plugin/enable':
    case 'plugin/disable': {
      const plugin = pluginInventory.find(plugin => plugin.id === request.params.params?.pluginId)!
      plugin.enabled = method === 'plugin/enable'
      return { plugin }
    }
    case 'plugin/uninstall': {
      const index = pluginInventory.findIndex(
        plugin => plugin.id === request.params.params?.pluginId
      )
      if (index >= 0) pluginInventory.splice(index, 1)
      return {}
    }
    case 'skills/list':
      return {
        items: pluginInventory.map(plugin => ({
          name: `${plugin.name}-skill`,
          description: plugin.description,
          path: `${plugin.root}/SKILL.md`,
          enabled: plugin.enabled,
          can_set_enabled: true,
        })),
      }
    case 'mcp/list':
      return {
        servers: [
          {
            name: 'research-search',
            transport: 'http',
            authorization: 'authorized',
            lastConnectionAttempt: 'ready',
          },
        ],
      }
    case 'runtime.providers.list':
      return {
        profiles: [profile],
        restartRequired: false,
        revision: 'fixture-revision',
        currentTurnConfiguration: configuration,
        supportsTurnModelReload: true,
        supportsNewSessionReload: true,
        supportsIndependentProbe: true,
        supportsOptimisticConcurrency: true,
        supportsClearUserOverrides: true,
        clearableUserOverrides: [
          'max_tokens',
          'context_window_tokens',
          'context_output_headroom',
          'auto_compact_threshold_tokens',
          'model_reasoning_effort',
          'model_capabilities',
        ],
      }
    case 'runtime.providers.templates':
      return { templates: [], supportsAuthenticationPolicy: true }
    case 'settings/templates/list':
      return { templates: [] }
    case 'knowledge/status':
      return { enabled: true, retrievalEnabled: false, organizationEnabled: true }
    case 'knowledge/list':
      return {
        items: [{ id: 'wiki', name: '我的知识空间', purpose: '', revision: 1, archived: false }],
      }
    case 'knowledge/default/read':
      return { libraryId: 'wiki' }
    case 'knowledge/page/list':
      return wikiListing(pages, 'pageId', request.params.params)
    case 'knowledge/source/list':
      return wikiListing(sources, 'sourceId', request.params.params)
    case 'knowledge/page/read':
      return {
        revisionId: 'revision-0',
        humanEdited: false,
        draft: {
          pageId: 'page-0',
          title: titles[0],
          markdown: '# SGLang\n\nFixture knowledge content.',
          citations: [],
        },
      }
    case 'knowledge/page/links':
      return { outgoing: [], incoming: [] }
    case 'knowledge/job/overview':
      return { items: [] }
    case 'knowledge/fileCapabilities':
      return {
        supported: true,
        items: wikiFileCapabilities,
        batchMaxFiles: 10,
        batchMaxBytes: 128 * 1024 * 1024,
      }
    case 'knowledge/imageImport/list':
      return {
        supported: true,
        items: ['发票255.png', '24.png'].map((title, index) => ({
          id: `image-${index}`,
          title,
          idempotencyKey: `image-${index}`,
          status: index ? 'completed' : 'cancelled',
          phase: index ? 'commit' : 'interpretation',
          reservedCalls: 1,
          callLimit: 1,
          usageReportedCalls: 1,
          unknownUsageCalls: 0,
          textBytes: 0,
          reasoningBytes: 0,
          updatedAtMs: now,
        })),
        nextAfterId: null,
      }
    default:
      throw new Error(`Unexpected fixture method: ${method}`)
  }
})
const evidence: WorkflowVersionVerification = {
  definitionId: 'reference',
  savedVersion: 3,
  draftStatus: 'saved',
  staticCheck: {
    savedVersion: 3,
    definitionSha256: 'hash',
    checkedAtMs: now,
    checkedNodes: [
      'brief',
      'outline_loop',
      'draft',
      'draft_audit',
      'route',
      'revise',
      'merge_final',
      'pick_best',
      'fact_check',
      'edit',
      'need_approval',
      'approval',
      'apply_review',
      'pkg_merge',
      'deliver',
      'result_out',
    ],
    checks: [
      'dependency_graph',
      'schema_defaults',
      'declared_pointers',
      'pure_code_syntax',
      'node_contracts',
    ],
    toolContracts: 'checked',
  },
  runs: [
    {
      definitionId: 'reference',
      savedVersion: 3,
      definitionSha256: 'hash',
      runId: 'workflow-4b225af-71ce-4a25-8975-f47ba6e5d0bf',
      resumeCount: 1,
      artifactAttempt: 1,
      outcomeCertainty: 'known',
      startedAtMs: now,
      updatedAtMs: now,
      executionStatus: 'completed',
      checkStatus: 'passed',
      scope: 'configured_result_checks',
      checkedNodes: [
        'brief',
        'outline_loop',
        'draft_audit',
        'revise',
        'pick_best',
        'fact_check',
        'edit',
        'deliver',
      ],
      skippedNodes: ['approval', 'apply_review'],
      inputSha256: 'input',
      privateInputRef: 'synthetic-private-input',
      interactionModified: false,
      modelSnapshot: {
        configuration,
        agents: [
          {
            agentId:
              'node-de2dc96ae8955dcef37dfe4c0a12bc00763facadfdca34afa1e34445fba0d73c-n2-i0-a0',
            runId: 'workflow-4b225af-71ce-4a25-8975-f47ba6e5d0bf',
            artifactAttempt: 1,
            selectionSource: 'inherited_session',
            configuration: {
              ...configuration,
              toolSet: { profile: 'full', registryScope: 'session_role', registeredToolCount: 15 },
            },
          },
        ],
      },
    },
  ],
}
const state: typeof initialWorkbenchState = {
  ...initialWorkbenchState,
  isBootstrapping: false,
  standaloneDeviceId: 'local',
  devices: [
    {
      id: 1,
      device_id: 'local',
      name: '当前计算机',
      status: 'online',
      is_default: true,
      device_type: 'local',
      bind_shell: 'claudecode',
    },
  ],
}
const context = { state } as WorkbenchContextValue
const panel = query.get('panel')
createRoot(document.getElementById('root')!).render(
  <WorkbenchContext.Provider value={context}>
    {panel === 'processing' ? (
      <ProcessingWindowFixture />
    ) : panel === 'plugins' ? (
      <div className="flex h-dvh">
        <KCoderPluginManagementWorkspace targetDeviceId="local" />
      </div>
    ) : panel === 'wiki' ? (
      <div className="flex h-dvh">
        <KnowledgeWorkspace />
      </div>
    ) : panel === 'workflow' ? (
      <SettingsDialog
        title="版本与设置"
        testId="reference-workflow-dialog"
        closeLabel="关闭"
        onClose={() => {}}
      >
        <div className="pt-5">
          <WorkflowVerification
            definitionId="reference"
            version={3}
            verification={evidence}
            onPrepareVerification={() => {}}
          />
        </div>
        <div className="sticky bottom-0 mt-5 flex justify-end border-t border-border/50 bg-popover pt-4">
          <Button variant="secondary">关闭</Button>
        </div>
      </SettingsDialog>
    ) : (
      <div
        data-testid="reference-settings-scroll"
        className="h-dvh overflow-y-auto px-8 py-8 max-md:px-4 max-md:py-4"
      >
        {panel === 'usage' ? <UsageSettingsPage /> : <KCoderProviderSettingsPage />}
      </div>
    )}
  </WorkbenchContext.Provider>
)
