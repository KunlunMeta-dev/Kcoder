import { OctopPageShell, OctopSurface } from '@/features/octop/OctopSurface'
import { useTranslation } from '@/hooks/useTranslation'
import { ChannelConnectionsWorkspace } from './ChannelConnectionsWorkspace'

/** Connections belong to this Gateway and can bind tasks from any configured runtime target. */
export function ChannelsPage() {
  const { t } = useTranslation('connectivity')
  return <OctopSurface>
    <OctopPageShell title={t('channelsPage.title')} subtitle={t('chatTasks.connectionDescription')} testId="channels-page">
      <div className="flex min-h-0 min-w-0 flex-1 flex-col overflow-y-auto overscroll-contain" data-testid="channels-page-scroll">
        <ChannelConnectionsWorkspace />
      </div>
    </OctopPageShell>
  </OctopSurface>
}
