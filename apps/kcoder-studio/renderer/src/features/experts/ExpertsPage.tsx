import { useState } from 'react'
import { UsersRound } from 'lucide-react'
import { OctopSurface } from '@/features/octop/OctopSurface'
import { WorkspacePageHeader } from '@/components/layout/WorkspacePageHeader'
import { SettingsSelect } from '@/components/settings/SettingsSelect'
import { useTranslation } from '@/hooks/useTranslation'
import { useRuntimeSettingsTargets } from '@/features/runtime-target/useRuntimeSettingsTargets'
import { useWorkbench } from '@/features/workbench/useWorkbench'
import { workbenchModelTarget } from '@/features/workbench/workbenchModelTarget'
import { usePluginTargetScope } from '@/kcoder/usePluginTargetScope'
import { ExpertWorkspace } from './ExpertWorkspace'
import { ExpertTarget } from './ExpertTarget'
import { ExpertLoading } from './ExpertLoading'
export { ExpertTarget } from './ExpertTarget'

export function ExpertsPage() {
  const { t } = useTranslation('experts')
  const targets = useRuntimeSettingsTargets()
  const { state } = useWorkbench()
  const current = workbenchModelTarget(state)
  const serverId = targets.selectedServerId
  const workspacePath =
    (serverId === current.deviceId ? current.workspacePath : undefined) ??
    targets.selectedTarget?.workspacePath
  const scope = usePluginTargetScope(serverId, workspacePath)
  const [revision, setRevision] = useState(0)
  return (
    <OctopSurface variant="workbench">
      <WorkspacePageHeader
        testId="experts-page-header"
        title={t('title')}
        actions={
          <SettingsSelect
            density="compact"
            icon={<UsersRound />}
            aria-label={t('target')}
            value={serverId}
            onChange={event => {
              targets.selectTarget(event.target.value)
              setRevision(0)
            }}
          >
            <option value="">{t('noTarget')}</option>
            {targets.targets.map(target => (
              <option key={target.id} value={target.id}>
                {target.label || target.id}
              </option>
            ))}
          </SettingsSelect>
        }
      />
      <div className="expert-page-content" data-testid="experts-page">
        <p className="mb-4 text-sm text-text-secondary">{t('description')}</p>
        {serverId ? (
          <ExpertTarget
            key={`${scope.key}:${revision}`}
            serverId={serverId}
            workspacePath={workspacePath}
            isCurrent={scope.isCurrent}
            onReconnect={() => setRevision(value => value + 1)}
            loadingFallback={<ExpertLoading testId="expert-target-loading" />}
          >
            {client => <ExpertWorkspace client={client} />}
          </ExpertTarget>
        ) : targets.loading ? (
          <ExpertLoading testId="expert-target-loading" />
        ) : (
          <p role="status" className="p-5">
            {t('noTarget')}
          </p>
        )}
      </div>
    </OctopSurface>
  )
}
