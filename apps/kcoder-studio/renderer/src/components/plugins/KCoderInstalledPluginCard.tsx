import { useState } from 'react'
import { Info, Trash2, UserRound } from 'lucide-react'
import type { InstalledPlugin, PluginMarketplaceItem } from '@/types/api'
import { useTranslation } from '@/hooks/useTranslation'
import { ActionMenu } from '@/components/common/ActionMenu'
import { ModalDialog } from '@/components/ui/modal-dialog'
import { Switch } from '@/components/ui/switch'
import { PluginIcon, type PluginIconLoader } from './PluginIcon'
import { installedPluginTags } from './installed-plugin-metadata'

export function KCoderInstalledPluginCard({
  id,
  plugin,
  catalog,
  iconLoader,
  disabled,
  confirming,
  onToggle,
  onUninstall,
  onConfirm,
  onCancel,
}: {
  id: string
  plugin: InstalledPlugin
  catalog?: PluginMarketplaceItem
  iconLoader?: PluginIconLoader
  disabled: boolean
  confirming: boolean
  onToggle: () => void
  onUninstall: () => void
  onConfirm: () => void
  onCancel: () => void
}) {
  const { t } = useTranslation('common')
  const [detailsOpen, setDetailsOpen] = useState(false)
  const tags = installedPluginTags(plugin, catalog)
  const author = plugin.spec.author || catalog?.author || plugin.spec.interface?.developerName || id
  const pluginInterface = plugin.spec.interface ?? catalog?.interface
  const componentLabels: Record<string, string> = {
    skills: t('workbench.plugin_component_type_skill'),
    commands: t('workbench.plugin_component_type_command'),
    agents: t('workbench.plugin_component_type_agent'),
    hooks: t('workbench.plugin_component_type_hook'),
    mcps: t('workbench.plugin_component_type_mcp'),
    lsps: 'LSP',
    monitors: t('workbench.plugin_component_type_monitor'),
    bins: t('workbench.plugin_component_type_binary'),
  }
  const actionClass =
    'inline-flex min-h-11 items-center justify-center gap-2 rounded-xl border border-border bg-background px-4 text-sm hover:bg-surface disabled:opacity-50 md:min-h-10'
  return (
    <article
      data-testid={`kcoder-plugin-row-${id}`}
      className="flex flex-wrap items-center gap-x-7 gap-y-4 rounded-xl border border-border/60 bg-background px-4 py-3 md:flex-nowrap"
    >
      <PluginIcon
        id={id}
        source={pluginInterface?.logo}
        darkSource={pluginInterface?.logoDark}
        loader={iconLoader}
        revision={plugin.spec.version ?? undefined}
        className="size-[60px] bg-surface text-focus"
      />
      <div className="min-w-0 flex-1 basis-3/4 md:basis-auto">
        <div className="flex flex-wrap items-center gap-x-4 gap-y-1">
          <h2 className="break-words text-lg font-semibold">{plugin.spec.displayName}</h2>
          {plugin.spec.version && (
            <span className="rounded-md bg-surface px-2 py-0.5 text-xs text-text-secondary">
              {plugin.spec.version}
            </span>
          )}
        </div>
        {plugin.spec.description && (
          <p className="mt-1 break-words text-xs leading-snug text-text-secondary">
            {plugin.spec.description}
          </p>
        )}
        <div className="mt-1.5 flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-text-secondary">
          <span className="inline-flex min-w-0 items-center gap-1.5">
            <UserRound className="size-4 shrink-0" aria-hidden="true" />
            <span className="break-all">{author}</span>
          </span>
          <ul
            className="flex flex-wrap gap-2"
            aria-label={t('workbench.plugins_skill_upload_tags')}
          >
            {tags.slice(0, 4).map(tag => (
              <li key={tag} className="rounded-md bg-surface px-3 py-0.5">
                {tag}
              </li>
            ))}
            {tags.length > 4 && (
              <li
                className="rounded-md bg-surface px-2 py-0.5 text-focus"
                title={tags.slice(4).join(', ')}
              >
                +{tags.length - 4}
              </li>
            )}
          </ul>
        </div>
      </div>
      <div className="flex shrink-0 flex-wrap items-center gap-6 max-md:ml-auto">
        <label className="mr-2 inline-flex items-center gap-3 text-base">
          <Switch
            data-testid={`kcoder-plugin-toggle-${id}`}
            aria-label={t('workbench.plugins_activation_label', { name: plugin.spec.displayName })}
            checked={plugin.spec.enabled}
            disabled={disabled}
            onCheckedChange={onToggle}
          />
          {t(
            plugin.spec.enabled
              ? 'workbench.kcoder_plugins_enable'
              : 'workbench.kcoder_plugins_disable'
          )}
        </label>
        <ActionMenu
          testId={`kcoder-plugin-actions-${id}`}
          ariaLabel={t('workbench.plugins_more_actions')}
          placement="bottom-end"
          disabled={disabled}
          triggerClassName="!size-11 rounded-xl border border-border md:!h-10 md:!w-12"
          items={[
            {
              label: t('workbench.plugins_view_details'),
              icon: Info,
              testId: `kcoder-plugin-details-${id}`,
              onSelect: () => setDetailsOpen(true),
            },
          ]}
        />
        {confirming ? (
          <div className="flex flex-wrap gap-2">
            <button
              data-testid={`kcoder-plugin-confirm-uninstall-${id}`}
              className={actionClass}
              disabled={disabled}
              onClick={onConfirm}
            >
              {t('workbench.kcoder_plugins_confirm_uninstall')}
            </button>
            <button className={actionClass} disabled={disabled} onClick={onCancel}>
              {t('workbench.kcoder_plugins_cancel')}
            </button>
          </div>
        ) : (
          <button
            data-testid={`kcoder-plugin-uninstall-${id}`}
            className={actionClass}
            disabled={disabled}
            onClick={onUninstall}
          >
            <Trash2 className="size-4" aria-hidden="true" />
            {t('workbench.kcoder_plugins_uninstall')}
          </button>
        )}
      </div>
      {detailsOpen && (
        <ModalDialog
          title={plugin.spec.displayName}
          testId="kcoder-plugin-details"
          onClose={() => setDetailsOpen(false)}
          closeLabel={t('workbench.kcoder_plugins_cancel')}
        >
          <p className="break-words text-sm text-text-secondary">{plugin.spec.description}</p>
          <p className="mt-3 break-all text-xs text-text-muted">{id}</p>
          <h3 className="mt-5 text-base font-semibold">{t('workbench.plugin_detail_contents')}</h3>
          <ul className="mt-3 space-y-2 text-sm">
            {Object.entries(plugin.spec.components).flatMap(([kind, entries]) =>
              entries.map((item: { name: string }) => (
                <li
                  key={`${kind}:${item.name}`}
                  className="flex flex-wrap justify-between gap-2 border-b border-border/60 py-2"
                >
                  <span className="break-all">{item.name}</span>
                  <span className="text-text-secondary">{componentLabels[kind] ?? kind}</span>
                </li>
              ))
            )}
          </ul>
        </ModalDialog>
      )}
    </article>
  )
}
