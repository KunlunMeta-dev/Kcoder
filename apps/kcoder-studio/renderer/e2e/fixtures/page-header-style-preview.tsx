import { BookOpen, Server } from 'lucide-react'
import { WorkspacePageHeader } from '../../src/components/layout/WorkspacePageHeader'
import { SettingsSelect } from '../../src/components/settings/SettingsSelect'

export function PageHeaderStylePreview() {
  return (
    <div className="space-y-5 p-5">
      {[
        ['wiki', 'Wiki'],
        ['tasks', '任务看板'],
        ['schedule', '定时任务'],
        ['workflow', '工作流'],
        ['plugins', '插件'],
        ['channels', '通讯渠道'],
      ].map(([id, title]) => (
        <section key={id} className="overflow-hidden rounded-xl border border-border bg-background">
          <WorkspacePageHeader
            title={title}
            testId={`header-${id}`}
            actions={
              <SettingsSelect
                density="compact"
                icon={id === 'wiki' ? <BookOpen /> : <Server />}
                aria-label={`${title}运行目标`}
                value="local"
                onChange={() => {}}
              >
                <option value="local">当前计算机</option>
              </SettingsSelect>
            }
          />
          <div className="px-5 py-4 text-sm text-text-secondary">{title} · 统一返回栏预览</div>
        </section>
      ))}
    </div>
  )
}
