import { Box, CheckSquare, Settings, ShoppingBag, Store } from 'lucide-react'
import { useTranslation } from '@/hooks/useTranslation'
import { navigateTo } from '@/lib/navigation'

export type PluginNavigationItem = 'manage' | 'store' | 'installed' | 'markets'

export function PluginNavigationRail({
  active,
  onInstalled,
  onManage,
}: {
  active: PluginNavigationItem
  onInstalled?: () => void
  onManage?: () => void
}) {
  const { t } = useTranslation('common')
  const items = [
    { id: 'manage', icon: Box, key: 'plugins_manage', path: '/plugins/manage' },
    { id: 'store', icon: Store, key: 'plugins_store', path: '/plugins' },
    {
      id: 'installed',
      icon: CheckSquare,
      key: 'plugins_installed',
      path: '/plugins/manage?view=installed',
    },
    {
      id: 'markets',
      icon: ShoppingBag,
      key: 'plugins_markets',
      path: '/plugins?view=marketplaces',
    },
    { id: 'settings', icon: Settings, key: 'plugins_settings', path: '/settings/plugins' },
  ] as const
  return (
    <nav
      aria-label={t('workbench.plugins_navigation')}
      className="flex shrink-0 gap-1 overflow-x-auto border-b border-border bg-surface/40 p-3 md:w-52 md:flex-col md:gap-0 md:overflow-x-visible md:border-b-0 md:border-r md:px-4 md:py-6"
    >
      {items.map(({ id, icon: Icon, key, path }) => (
        <button
          key={id}
          type="button"
          data-testid={`plugin-navigation-${id}`}
          aria-current={active === id ? 'page' : undefined}
          className={`flex min-h-11 shrink-0 items-center gap-4 whitespace-nowrap rounded-lg px-4 text-left text-base transition-colors md:min-h-[52px] ${active === id ? 'bg-accent-surface font-semibold text-focus' : 'text-text-secondary hover:bg-surface hover:text-text-primary'}`}
          onClick={() =>
            id === 'installed' && onInstalled
              ? onInstalled()
              : id === 'manage' && onManage
                ? onManage()
                : navigateTo(path)
          }
        >
          <Icon className="size-5 shrink-0" aria-hidden="true" />
          {t(`workbench.${key}`)}
        </button>
      ))}
    </nav>
  )
}
