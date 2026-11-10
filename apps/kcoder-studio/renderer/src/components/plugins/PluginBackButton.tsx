import { ArrowLeft } from 'lucide-react'
import { useTranslation } from '@/hooks/useTranslation'
import { navigateToParentPage } from '@/lib/navigation'

export function PluginBackButton() {
  const { t } = useTranslation('common')
  return (
    <button
      type="button"
      data-testid="plugins-back-button"
      onClick={navigateToParentPage}
      className="inline-flex min-h-9 shrink-0 items-center gap-1.5 rounded-lg px-2 text-sm text-text-secondary transition-colors hover:bg-muted hover:text-text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus max-md:min-h-11 [-webkit-app-region:no-drag]"
    >
      <ArrowLeft className="size-4" aria-hidden="true" />
      {t('workbench.settings_back_to_app', '返回')}
    </button>
  )
}
