import { useLayoutEffect, useState } from 'react'
import { createRoot } from 'react-dom/client'
import i18n from '../../src/i18n'
import '../../src/styles/globals.css'
import { WorkspacePageHeader } from '../../src/components/layout/WorkspacePageHeader'
import { SettingsSelect } from '../../src/components/settings/SettingsSelect'
import { Button } from '../../src/components/ui/button'
import { applyAppearance } from '../../src/features/appearance/applyAppearance'
import { defaultAppearance } from '../../src/features/appearance/presets'
import { ExpertClient, newExpert } from '../../src/features/experts/client'
import { ExpertWorkspace } from '../../src/features/experts/ExpertWorkspace'
import { OfficeController } from '../../src/features/office-integration/controller'
import { OctopSurface } from '../../src/features/octop/OctopSurface'

// Deterministic presentation fixture. It has no Native target, model or platform connection.
await i18n.changeLanguage('zh-CN')
const scope = {
  accountId: 'visual-fixture',
  targetId: 'local',
  workspaceId: '/visual-fixture',
  identityGeneration: 'fixture',
  targetRevision: 'fixture',
}
const experts = [
  ['contract', '合同起草专家', '审查合同条款，整理风险与修改建议，协助起草清晰、完整的合同文本。'],
  ['review', '代码审查专家', '检查代码质量、边界条件和可维护性，并给出具体的修改建议。'],
].map(([id, title, description]) => ({
  definition: {
    ...newExpert('zh-CN'),
    id: 'personal.' + id,
    title,
    description,
    inputSchema: { type: 'object', 'x-kcoder-expert': { avatarPreset: 'generic', enabled: true } },
  },
  builtin: false,
  draftRevision: 1,
}))
const library = {
  ...experts[0],
  builtin: true,
  definition: {
    ...experts[0].definition,
    id: 'builtin.octop.contract',
    title: '合同专家模板',
  },
}
type CatalogResource = 'personal' | 'library' | 'market'
const heldResources = new Set(
  new URLSearchParams(location.search).get('holdCatalogs')?.split(',') ?? []
)
const emptyResources = new Set(
  new URLSearchParams(location.search).get('emptyCatalogs')?.split(',') ?? []
)
const catalogCalls: Array<{ resource: CatalogResource; query: string }> = []
const heldReads = new Map<
  CatalogResource,
  { resolve: () => void; reject: (error: Error) => void }
>()
declare global {
  interface Window {
    __expertCatalogFixture: {
      calls: () => typeof catalogCalls
      holdNext: (resource: CatalogResource) => void
      release: (resource: CatalogResource) => void
      fail: (resource: CatalogResource) => void
      empty: (resource: CatalogResource) => void
    }
  }
}
window.__expertCatalogFixture = {
  calls: () => [...catalogCalls],
  holdNext: resource => {
    heldResources.add(resource)
  },
  release: resource => {
    const read = heldReads.get(resource)
    if (!read) throw new Error('No held catalog read: ' + resource)
    heldReads.delete(resource)
    read.resolve()
  },
  fail: resource => {
    const read = heldReads.get(resource)
    if (!read) throw new Error('No held catalog read: ' + resource)
    heldReads.delete(resource)
    read.reject(new Error('Fixture catalog read failed'))
  },
  empty: resource => {
    emptyResources.add(resource)
  },
}
const client = new ExpertClient(
  new OfficeController(
    {
      async call(method, request) {
        let result: unknown
        const resource =
          method === 'integrations/assistant/list'
            ? request.payload.personalOnly === false
              ? 'library'
              : 'personal'
            : method === 'integrations/assistant/market/list'
              ? 'market'
              : null
        if (resource) {
          catalogCalls.push({ resource, query: String(request.payload.query ?? '') })
          if (heldResources.delete(resource))
            await new Promise<void>((resolve, reject) => {
              heldReads.set(resource, { resolve, reject })
            })
        }
        if (method === 'integrations/assistant/list')
          result = {
            items:
              resource && emptyResources.has(resource)
                ? []
                : request.payload.personalOnly === false
                  ? [library]
                  : experts,
            nextCursor: null,
            total: request.payload.personalOnly === false ? 1 : experts.length,
          }
        else if (method === 'integrations/assistant/versions')
          result = { items: [], nextCursor: null }
        else if (method === 'integrations/assistant/package/read') result = { package: null }
        else if (method === 'integrations/assistant/market/list')
          result = { items: [], scenes: [], nextCursor: null, total: 0 }
        else
          throw new Error('The visual fixture does not perform writes or external calls: ' + method)
        return {
          contractVersion: 'parallel-v1',
          requestId: request.requestId,
          operationId: null,
          entityRevision: null,
          observedAt: new Date().toISOString(),
          status: 'completed',
          result,
          error: null,
        }
      },
    },
    () => scope
  )
)

export function ExpertStylePreview() {
  const [mode, setMode] = useState<'light' | 'dark'>('light')
  const [fontSize, setFontSize] = useState(14)
  useLayoutEffect(() => {
    applyAppearance({ ...defaultAppearance, mode, uiFontSize: fontSize }, mode)
  }, [mode, fontSize])
  return (
    <main className="min-h-screen bg-background text-text-primary">
      <div className="flex flex-wrap items-center gap-2 border-b border-border px-5 py-2">
        <Button
          size="sm"
          variant="outline"
          data-testid="expert-preview-theme"
          onClick={() => setMode(mode === 'light' ? 'dark' : 'light')}
        >
          切换主题
        </Button>
        <Button
          size="sm"
          variant="outline"
          data-testid="expert-preview-font"
          onClick={() => setFontSize(fontSize === 14 ? 16 : 14)}
        >
          切换字号
        </Button>
        <span className="text-sm text-text-secondary">示例数据 · 仅验证界面</span>
      </div>
      <div className="h-[760px] min-w-0" data-testid="expert-style-preview">
        <OctopSurface variant="workbench">
          <WorkspacePageHeader
            title="专家"
            onBack={() => {}}
            actions={
              <SettingsSelect
                density="compact"
                aria-label="运行目标"
                value="local"
                onChange={() => {}}
              >
                <option value="local">当前计算机</option>
              </SettingsSelect>
            }
          />
          <div className="expert-page-content">
            <p className="mb-4 text-sm text-text-secondary">
              创建与管理你的 AI 专家，也可从模板一键新建
            </p>
            <ExpertWorkspace client={client} />
          </div>
        </OctopSurface>
      </div>
    </main>
  )
}

createRoot(document.getElementById('root')!).render(<ExpertStylePreview />)
