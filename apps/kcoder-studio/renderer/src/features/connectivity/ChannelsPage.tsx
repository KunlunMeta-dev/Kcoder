import { ArrowLeft } from 'lucide-react'
import { OctopPageShell, OctopSurface } from '@/features/octop/OctopSurface'
import { useTranslation } from '@/hooks/useTranslation'
import { navigateTo } from '@/lib/navigation'
import { ChannelConnectionsWorkspace } from './ChannelConnectionsWorkspace'

/** Connections belong to this Gateway and can bind tasks from any configured runtime target. */
export function ChannelsPage() {
  const { t } = useTranslation('connectivity')
  return (
    <OctopSurface>
      <OctopPageShell
        title={t('channelsPage.title')}
        subtitle={t('chatTasks.connectionDescription')}
        testId="channels-page"
        actions={
          <button
            type="button"
            data-testid="mobile-channels-back"
            onClick={() => navigateTo('/')}
            className="flex min-h-11 items-center gap-2 rounded-lg px-2 text-sm text-text-secondary hover:bg-muted focus-visible:ring-2 focus-visible:ring-focus md:hidden"
          >
            <ArrowLeft className="h-4 w-4" aria-hidden="true" />
            {t('common:workbench.plugins_back_to_workbench')}
          </button>
        }
      >
        <div className="flex min-h-0 min-w-0 flex-1 flex-col overflow-y-auto overscroll-contain" data-testid="channels-page-scroll">
          <ChannelConnectionsWorkspace />
        </div>
      </OctopPageShell>
    </OctopSurface>
  )
}
