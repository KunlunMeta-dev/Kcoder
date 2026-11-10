import { createRoot } from 'react-dom/client'
import i18n from '../../src/i18n'
import '../../src/styles/globals.css'
import { resolveUiTypographyVariables } from '../../src/features/appearance/typography'
import {
  KnowledgeIntegrationClient,
  KnowledgeIntegrationWorkspace,
  knowledgeIntegrationEn,
  knowledgeIntegrationZh,
} from '../../src/features/knowledge-integration'
import type {
  IntegrationRequest,
  KnowledgePublication,
  AutomationSubscription,
  AutomationRun,
} from '../../../shared/generated/contracts'

// Layout preview only. Actual components and generated DTOs use synthetic data, without Native/model/platform calls.
i18n.addResourceBundle('zh-CN', 'knowledgeIntegration', knowledgeIntegrationZh)
i18n.addResourceBundle('en', 'knowledgeIntegration', knowledgeIntegrationEn)
await i18n.changeLanguage('zh-CN')
for (const [key, value] of Object.entries(resolveUiTypographyVariables(14)))
  document.documentElement.style.setProperty(key, value)
const query = new URLSearchParams(location.search)
const theme = query.get('theme') === 'dark' ? 'dark' : 'light'
document.documentElement.classList.toggle('dark', theme === 'dark')
document.documentElement.dataset.theme = theme
const owner = { accountId: 'preview-owner', targetId: 'preview-local', workspaceId: null }
const scope = {
  ...owner,
  identityGeneration: 'preview-identity',
  targetRevision: 'preview-settings',
}
const publications: KnowledgePublication[] = [
  {
    owner,
    version: 2,
    publishedAtMs: Date.parse('2026-10-23T09:00:00+08:00'),
    revoked: false,
    draft: {
      publicationId: 'preview-policy',
      title: '会议纪要与工作简报写作规范',
      visibility: 'personal',
      sources: [
        {
          libraryId: 'preview-library',
          pageId: 'preview-page-style',
          pageRevision: 'preview-style-v2',
        },
      ],
      unresolved: [],
    },
    pages: [
      {
        source: {
          libraryId: 'preview-library',
          pageId: 'preview-page-style',
          pageRevision: 'preview-style-v2',
        },
        title: '写作与来源要求',
        markdown:
          '先写结论和待办，再补背景。事实、数据和日期应对应来源；没有材料支持的内容列入待确认项。会议纪要明确负责人、完成时间和验收方式。',
      },
    ],
  },
  {
    owner,
    version: 1,
    publishedAtMs: Date.parse('2026-10-22T09:00:00+08:00'),
    revoked: false,
    draft: {
      publicationId: 'preview-guide',
      title: '政务事项办理资料清单（示例）',
      visibility: 'personal',
      sources: [
        {
          libraryId: 'preview-library',
          pageId: 'preview-page-guide',
          pageRevision: 'preview-guide-v1',
        },
      ],
      unresolved: [],
    },
    pages: [
      {
        source: {
          libraryId: 'preview-library',
          pageId: 'preview-page-guide',
          pageRevision: 'preview-guide-v1',
        },
        title: '资料清单',
        markdown:
          '登记事项名称、来源单位、办理状态及材料出处。未提供的文号和时限不得补写；发现材料缺失时形成待补清单。',
      },
    ],
  },
]
const subscriptions: AutomationSubscription[] = [
  {
    owner,
    revision: 1,
    enabled: true,
    consentRef: 'preview-explicit-consent',
    createdAtMs: Date.parse('2026-10-20T08:00:00+08:00'),
    updatedAtMs: Date.parse('2026-10-20T08:00:00+08:00'),
    nextFireAtMs: Date.parse('2026-10-25T09:00:00+08:00'),
    draft: {
      id: 'preview-daily-report',
      title: '每日事项办理简报',
      workflowId: 'preview-report-flow',
      workflowVersion: 3,
      inputs: { range: '已授权的事项台账', acceptance: '列出办理数量、待办和异常，并逐项标注来源' },
      schedule: { kind: 'zoned_cron', expression: '0 9 * * *', timezone: 'Asia/Shanghai' },
      maximumTokens: 5000,
      maximumRuntimeSeconds: 300,
      delivery: { kind: 'studio' },
    },
  },
  {
    owner,
    revision: 2,
    enabled: false,
    consentRef: 'preview-weekly-consent',
    createdAtMs: Date.parse('2026-10-18T08:00:00+08:00'),
    updatedAtMs: Date.parse('2026-10-23T08:00:00+08:00'),
    draft: {
      id: 'preview-weekly-check',
      title: '每周材料完整性检查',
      workflowId: 'preview-check-flow',
      workflowVersion: 1,
      inputs: {},
      schedule: { kind: 'zoned_cron', expression: '0 16 * * 5', timezone: 'Asia/Shanghai' },
      maximumTokens: 3000,
      maximumRuntimeSeconds: 180,
      delivery: { kind: 'studio' },
    },
  },
]
const runs: AutomationRun[] = [
  {
    id: 'preview-run-daily',
    title: '事项办理简报 · 10 月 24 日',
    owner,
    subscriptionId: 'preview-daily-report',
    subscriptionRevision: 1,
    triggerId: 'preview-trigger-daily',
    nativeOperationId: 'preview-native-operation',
    nativeThreadId: 'preview-native-thread',
    nativeTurnId: 'preview-native-turn',
    status: 'completed',
    deliveryStatus: 'studio_available',
    output:
      '【示例成果】已汇总 12 项事项，其中 9 项已办结、3 项待补材料。负责人、来源和待确认事项均保留在原任务中。',
    artifactRefs: ['preview-report-artifact'],
    createdAtMs: Date.parse('2026-10-24T09:00:00+08:00'),
    updatedAtMs: Date.parse('2026-10-24T09:02:00+08:00'),
  },
  {
    id: 'preview-run-weekly',
    title: '材料完整性检查 · 第 43 周',
    owner,
    subscriptionId: 'preview-weekly-check',
    subscriptionRevision: 1,
    triggerId: 'preview-trigger-weekly',
    nativeOperationId: 'preview-native-weekly',
    status: 'waiting',
    deliveryStatus: 'not_ready',
    artifactRefs: [],
    createdAtMs: Date.parse('2026-10-23T16:00:00+08:00'),
    updatedAtMs: Date.parse('2026-10-23T16:01:00+08:00'),
  },
]
function response(request: IntegrationRequest, result: Record<string, unknown>) {
  return {
    contractVersion: 'parallel-v1',
    requestId: request.requestId,
    operationId: request.operationId ?? null,
    entityRevision: null,
    observedAt: '2026-10-24T08:00:00Z',
    status: 'completed',
    result,
    error: null,
  }
}
const client = new KnowledgeIntegrationClient(scope, {
  async call(_port, method, request) {
    if (method === 'listMemories')
      return response(request, { page: { items: [], nextCursor: null } })
    if (method === 'previewSubscription')
      return response(request, { nextFireAtMs: Date.parse('2026-10-25T09:00:00+08:00') })
    if (method === 'retrieveKnowledge')
      return response(request, {
        retrieval: {
          outcome: 'matched',
          observedAtMs: Date.parse('2026-10-24T08:00:00Z'),
          hits: [
            {
              publicationId: publications[0].draft.publicationId,
              version: 2,
              source: publications[0].pages[0].source,
              title: '写作与来源要求',
              excerpt: publications[0].pages[0].markdown,
            },
          ],
        },
      })
    throw new Error('preview layout does not submit native mutations')
  },
  async management(_domain, method, request) {
    if (method === 'readPublicationSources') {
      const publication = publications.find(
        item =>
          item.draft.publicationId === request.payload.publicationId &&
          item.version === request.payload.version
      )
      if (!publication) throw new Error('preview requires an explicit fixed publication version')
      return response(request, {
        page: {
          items: publication.draft.sources.map(source => ({
            source,
            available: publication.version === 2,
            removed: publication.version === 2,
            archived: publication.version === 2,
            observedAtMs: Date.parse('2026-10-24T08:00:00Z'),
          })),
          nextCursor: null,
        },
      })
    }
    const items =
      method === 'listPublications'
        ? publications
        : method === 'listSubscriptions'
          ? subscriptions
          : method === 'listAutomationRuns'
            ? runs
            : []
    return response(request, { page: { items, nextCursor: null } })
  },
})
createRoot(document.getElementById('root')!).render(
  <div className="min-h-screen bg-background text-text-primary">
    <div className="mx-auto flex max-w-5xl items-center justify-between border-b border-border px-5 py-3 text-sm text-text-muted">
      <span>KWorker Studio</span>
      <span data-testid="preview-boundary">界面预览 · 示例数据</span>
    </div>
    <KnowledgeIntegrationWorkspace
      client={client}
      wikiInputs={{
        ownerKey: client.ownerKey,
        listLibraries: async () => ({
          items: [{ id: 'preview-library', title: '示例 Wiki 资料库' }],
          nextCursor: null,
        }),
        listPages: async ({ libraryId }) => ({
          items: publications.flatMap(publication =>
            publication.pages
              .filter(page => page.source.libraryId === libraryId)
              .map(page => ({ title: page.title, source: page.source }))
          ),
          nextCursor: null,
        }),
      }}
      sourcePages={publications.flatMap(publication =>
        publication.pages.map(page => ({ title: page.title, source: page.source }))
      )}
      workflows={[
        { id: 'preview-report-flow', title: '事项办理日汇总', version: 3 },
        { id: 'preview-check-flow', title: '材料完整性检查', version: 1 },
      ]}
    />
  </div>
)
