import { describe, expect, it } from 'vitest'

const catalogs = import.meta.glob('./locales/{en,zh-CN}/*.json', {
  eager: true,
  import: 'default',
})

function strings(value: unknown, prefix = ''): Array<[string, string]> {
  if (typeof value === 'string') return [[prefix, value]]
  if (!value || typeof value !== 'object') return []
  return Object.entries(value).flatMap(([key, child]) =>
    strings(child, prefix ? `${prefix}.${key}` : key)
  )
}

// These keys describe existing external formats and import sources, not our product.
const compatibilityKeys = new Set([
  'workbench.plugins_marketplace_welcome_description',
  'workbench.plugins_plugin_upload_description',
  'workbench.codex_home_init_title',
  'workbench.codex_home_init_description',
  'workbench.local_codex_model_description',
  'workbench.execution_defaults_gateway_required',
])

const migrationCompatibilityKeys: Record<string, ReadonlySet<string>> = {
  // The provider settings migration entry names the import sources it reads from.
  common: new Set(['providerSettings.migrationDescription', 'providerSettings.migrationAction']),
  migration: new Set([
    'row_title', 'description', 'branch.related_boundary', 'conversation_history.sources.codex',
    'codex_layers.title', 'codex_layers.scope', 'codex-project-layers',
    'transferBrowser.description', 'sourceDirectory.boundary', 'firstUse.description',
    'firstUse.import', 'historyFamilies.discover', 'quickHistory.dialogDescription',
  ]),
  migrationMemory: new Set(['layouts.codex_memory_files_v1']),
  migrationUpload: new Set(['boundary', 'directoryHelp']),
}

describe('localized product branding', () => {
  it.each(Object.entries(catalogs))(
    '%s does not identify Studio as an upstream product',
    (file, catalog) => {
      const namespace = file.split('/').at(-1)?.replace(/\.json$/, '') ?? ''
      const violations = strings(catalog).filter(
        ([key, value]) =>
          /wework/i.test(key) || /wework|wegent/i.test(value) || (/codex/i.test(value)
            && !compatibilityKeys.has(key) && !migrationCompatibilityKeys[namespace]?.has(key))
      )
      expect(violations).toEqual([])
    }
  )

  it.each(['en', 'zh-CN'])(
    '%s does not relabel unsupported quota and cloud auth as KCoder services',
    locale => {
      const values = new Map(
        strings({
          ...(catalogs[`./locales/${locale}/common.json`] as object),
          ...(catalogs[`./locales/${locale}/common-workbench.json`] as object),
        })
      )
      for (const key of [
        'remaining_usage',
        'general_settings_tray_usage_description',
        'cloud_connection_description',
        'runtime_config_codex_description',
        'codex_plugin_remote_apps_description',
      ]) {
        expect(values.get(`workbench.${key}`)).toMatch(/unavailable|不可用/)
      }
    }
  )
})
