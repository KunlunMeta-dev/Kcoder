import { useState } from 'react'
import { Globe } from 'lucide-react'
import { SettingsSelect } from '@/components/settings/SettingsSelect'
import { Switch } from '@/components/ui/switch'
import { useTranslation } from '@/hooks/useTranslation'
import type { GatewayServer } from './gatewayRpc'
import {
  PLAYWRIGHT_PRESET_NAME,
  playwrightPresetAvailability,
  playwrightPresetConfig,
  type PlaywrightBrowser,
} from './mcpPresets'

/**
 * One-click entry for the bundled Playwright MCP on local same-account targets.
 * Writing the definition is the explicit user action; an existing server with
 * the preset name is shown as configured and never replaced.
 */
export function McpPlaywrightPreset({
  target,
  configured,
  busy,
  enable,
}: {
  target: GatewayServer | null | undefined
  configured: boolean
  busy: boolean
  enable: (config: Record<string, unknown>) => void
}) {
  const { t } = useTranslation('common')
  const availability = playwrightPresetAvailability(target)
  const facts = availability.kind === 'available' ? availability.facts : null
  const [browser, setBrowser] = useState<PlaywrightBrowser | null>(null)
  const selectedBrowser = browser ?? facts?.defaultBrowser ?? 'chrome'
  const unavailableReason =
    availability.kind === 'unsupportedTarget'
      ? t('workbench.mcp_playwright_unsupported_target')
      : availability.kind === 'runtimeUnavailable'
        ? t('workbench.mcp_playwright_runtime_unavailable')
        : null
  return (
    <article
      data-testid="kcoder-playwright-preset"
      className="studio-card-spacing flex flex-wrap items-center gap-4 rounded-xl border border-border/60 bg-background"
    >
      <Globe className="size-6 shrink-0 text-focus" aria-hidden="true" />
      <div className="min-w-0 flex-1">
        <h2 className="text-sm font-semibold">{t('workbench.mcp_playwright_title')}</h2>
        <p className="mt-1 text-xs text-text-muted">{t('workbench.mcp_playwright_description')}</p>
        <p className="mt-1 text-xs text-text-muted">{t('workbench.mcp_playwright_powerful_tools')}</p>
        {configured ? (
          <p role="status" className="mt-1 text-sm text-text-secondary">
            {t('workbench.mcp_preset_configured', { name: PLAYWRIGHT_PRESET_NAME })}
          </p>
        ) : unavailableReason ? (
          <p data-testid="kcoder-playwright-preset-unavailable" className="mt-1 text-sm text-text-secondary">
            {unavailableReason}
          </p>
        ) : (
          <label className="mt-2 flex max-w-xs flex-col gap-1 text-xs text-text-muted">
            {t('workbench.mcp_playwright_browser')}
            <SettingsSelect
              value={selectedBrowser}
              disabled={busy}
              data-testid="kcoder-playwright-browser"
              onChange={event => setBrowser(event.target.value as PlaywrightBrowser)}
            >
              <option value="chrome">{t('workbench.mcp_playwright_browser_chrome')}</option>
              <option value="msedge">{t('workbench.mcp_playwright_browser_msedge')}</option>
            </SettingsSelect>
          </label>
        )}
      </div>
      {!configured && (
        <Switch
          checked={false}
          disabled={busy || !facts}
          onCheckedChange={value => {
            if (value && facts) enable(playwrightPresetConfig(facts, selectedBrowser))
          }}
          aria-label={t('workbench.mcp_toggle', { name: PLAYWRIGHT_PRESET_NAME })}
          data-testid="kcoder-playwright-enable"
          className="shrink-0"
        />
      )}
    </article>
  )
}
