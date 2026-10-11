import { useState } from 'react'
import { Check, MoreHorizontal, RefreshCw } from 'lucide-react'
import { useTranslation } from '@/hooks/useTranslation'
import { marketplaceBlockReason } from '@/components/plugins/plugin-availability'
import { PluginIcon, type PluginIconLoader } from '@/components/plugins/PluginIcon'
import { resolvePluginAssetUrl } from '@/components/plugins/plugin-assets'
import type { PluginMarketplaceItem } from '@/types/api'
import { needsPluginCredentials } from './pluginInstallation'
import { canRevalidatePlugin, pluginCatalogIdentity } from './pluginLifecycle'

export function PluginMarketplaceRow({
  item,
  isInstalling,
  isCancelling,
  revalidationAvailable = false,
  isRevalidating = false,
  onCancel,
  installLabel,
  installingLabel,
  tryLabel,
  uninstallLabel,
  onOpen,
  onInstall,
  onUninstall,
  iconLoader,
  failure,
}: {
  iconLoader?: PluginIconLoader
  failure?: { message: string; details: string; revalidationKey?: string }
  item: PluginMarketplaceItem
  isInstalling: boolean
  isCancelling?: boolean
  revalidationAvailable?: boolean
  isRevalidating?: boolean
  onCancel?: () => void
  installLabel: string
  installingLabel: string
  tryLabel: string
  uninstallLabel: string
  onOpen: () => void
  onInstall: () => void
  onUninstall: () => void
}) {
  const { t } = useTranslation('common')
  const [isActionMenuOpen, setIsActionMenuOpen] = useState(false)
  const logo = resolvePluginAssetUrl(item.interface?.logo || item.interface?.composerIcon)
  const compatibility = item.manifest?.compatibility as
    { deferredCapabilities?: unknown } | undefined
  const unsupported = Array.isArray(compatibility?.deferredCapabilities)
    ? compatibility.deferredCapabilities.filter(
        (value): value is string => typeof value === 'string'
      )
    : []
  const capabilityLabels: Record<string, string> = {
    agents: t('workbench.plugin_component_type_agent'),
    commands: t('workbench.plugin_component_type_command'),
    apps: t('workbench.plugin_component_type_app'),
  }
  const blocked = marketplaceBlockReason(item.manifest)
  const needsCredentials = needsPluginCredentials(item.manifest)
  const retryable =
    canRevalidatePlugin(item.manifest) ||
    (item.installable !== false && failure?.revalidationKey === pluginCatalogIdentity(item))
  const unavailableReason =
    item.installable === false
      ? blocked
        ? t(blocked.key)
        : unsupported.length
          ? t('pluginNetwork.unsupportedOnly', {
              capabilities: unsupported.map(value => capabilityLabels[value] ?? value).join(', '),
            })
          : t('pluginNetwork.blockedPolicy')
      : undefined

  return (
    <article
      role="button"
      tabIndex={0}
      data-testid={`plugin-marketplace-row-${item.id}`}
      className="plugin-marketplace-card group"
      onClick={onOpen}
      onKeyDown={event => {
        if (event.target !== event.currentTarget) return
        if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault()
          onOpen()
        }
      }}
    >
      <div
        className="flex h-10 w-10 items-center justify-center overflow-hidden rounded-lg border border-border bg-surface text-text-secondary shadow-sm"
        style={{
          backgroundColor: item.interface?.brandColor || undefined,
          color: item.interface?.brandColor ? 'rgb(var(--color-bg-base))' : undefined,
        }}
      >
        <PluginIcon
          id={item.id}
          revision={`${item.installed ? 'installed' : 'catalog'}:${item.version ?? ''}`}
          source={logo}
          darkSource={item.interface?.logoDark}
          loader={iconLoader}
        />
      </div>
      <div className="min-w-0">
        <div className="flex min-w-0 items-center gap-2">
          <h3 className="truncate text-base font-semibold leading-5 text-text-primary">
            {item.displayName || item.name}
          </h3>
          {item.version && (
            <span className="shrink-0 rounded-md bg-surface px-1.5 py-0.5 text-xs font-normal leading-4 text-text-muted">
              {item.version}
            </span>
          )}
        </div>
        <p className="mt-2 line-clamp-2 text-sm leading-5 text-text-secondary">
          {item.interface?.shortDescription || item.description}
        </p>
      </div>
      {unavailableReason && (
        <p
          data-testid={`plugin-unavailable-reason-${item.id}`}
          className="col-span-2 text-xs leading-relaxed text-text-secondary"
        >
          {unavailableReason}
        </p>
      )}
      {failure && (
        <div
          role="status"
          data-testid={`plugin-install-failure-${item.id}`}
          className="col-span-2 min-w-0 rounded-lg border border-destructive/25 bg-destructive/5 p-3 text-sm"
          onClick={event => event.stopPropagation()}
        >
          <p className="text-destructive">{failure.message}</p>
          {failure.details && (
            <details className="mt-2 text-text-secondary">
              <summary className="cursor-pointer text-xs">
                {t('pluginNetwork.failureDetails')}
              </summary>
              <pre className="mt-2 max-h-40 overflow-auto whitespace-pre-wrap font-mono text-xs [overflow-wrap:anywhere]">
                {failure.details}
              </pre>
            </details>
          )}
        </div>
      )}
      <div className="plugin-card-actions flex items-center justify-end gap-1.5">
        <button
          type="button"
          data-testid={`plugin-marketplace-install-${item.id}`}
          disabled={
            isInstalling ||
            (!item.installed && retryable && !revalidationAvailable) ||
            (!item.installed &&
              item.installable === false &&
              !needsCredentials &&
              !(retryable && revalidationAvailable))
          }
          title={
            unavailableReason ??
            (item.installable === false ? t('pluginNetwork.unavailable') : undefined)
          }
          className={[
            'flex h-8 min-w-[58px] items-center justify-center gap-2 rounded-lg border px-3 text-sm font-medium transition-colors disabled:cursor-not-allowed disabled:opacity-50',
            item.installed
              ? 'border-border bg-background text-text-primary hover:bg-surface'
              : 'border-transparent bg-text-primary text-background hover:bg-text-primary/90',
            isInstalling ? 'cursor-wait opacity-70' : '',
          ].join(' ')}
          onClick={event => {
            event.stopPropagation()
            if (!isInstalling) onInstall()
          }}
        >
          {isRevalidating ? (
            t('pluginActivation.rechecking', 'Checking…')
          ) : !item.installed && retryable ? (
            t('pluginActivation.revalidate', 'Recheck availability')
          ) : !item.installed && needsCredentials ? (
            t('pluginNetwork.installInChat')
          ) : !item.installed && item.installable === false ? (
            t('pluginNetwork.unavailable')
          ) : isInstalling ? (
            <>
              <RefreshCw className="h-4 w-4 animate-spin" aria-hidden="true" />
              {isCancelling ? t('pluginNetwork.cancellingInstall') : installingLabel}
            </>
          ) : item.installed ? (
            <span className="inline-flex items-center gap-1.5">
              <Check className="h-4 w-4 text-text-muted" />
              {tryLabel}
            </span>
          ) : (
            installLabel
          )}
        </button>
        {isInstalling && onCancel && (
          <button
            type="button"
            data-testid={`plugin-marketplace-cancel-${item.id}`}
            disabled={isCancelling}
            className="rounded-lg px-2 py-1 text-xs text-text-secondary hover:bg-surface"
            onClick={event => {
              event.stopPropagation()
              onCancel()
            }}
          >
            {t('pluginNetwork.cancelInstall')}
          </button>
        )}
        {item.installed && (
          <div className="relative">
            <button
              type="button"
              data-testid={`plugin-marketplace-actions-${item.id}`}
              aria-label={`${item.displayName || item.name} · ${t('workbench.plugins_actions', '插件操作')}`}
              aria-expanded={isActionMenuOpen}
              className="flex h-8 w-8 items-center justify-center rounded-lg text-text-muted transition-colors hover:bg-background hover:text-text-primary"
              onClick={event => {
                event.stopPropagation()
                setIsActionMenuOpen(open => !open)
              }}
            >
              <MoreHorizontal className="h-4 w-4" />
            </button>
            {isActionMenuOpen && (
              <div
                data-testid={`plugin-marketplace-actions-menu-${item.id}`}
                className="absolute right-0 top-9 z-30 w-28 rounded-xl border border-border bg-background p-1 shadow-xl"
                onClick={event => event.stopPropagation()}
              >
                <button
                  type="button"
                  data-testid={`plugin-marketplace-uninstall-${item.id}`}
                  className="flex h-8 w-full items-center rounded-lg px-3 text-left text-sm leading-[18px] text-red-600 transition-colors hover:bg-red-50"
                  onClick={() => {
                    setIsActionMenuOpen(false)
                    onUninstall()
                  }}
                >
                  {uninstallLabel}
                </button>
              </div>
            )}
          </div>
        )}
      </div>
    </article>
  )
}
