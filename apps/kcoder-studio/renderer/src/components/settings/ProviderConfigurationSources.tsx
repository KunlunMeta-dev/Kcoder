import type { ProviderProfile } from '@/kcoder/providerSettings'
import { useTranslation } from '@/hooks/useTranslation'

import { fields, layers, hasFileOverrides } from './providerSourceMetadata'

export function ProviderConfigurationSources({ profile }: { profile?: ProviderProfile }) {
  const { t } = useTranslation('common')
  if (!profile) return null
  if (profile.availableInCurrentConfig === false)
    return (
      <p data-testid="provider-source-unavailable" className="text-sm text-muted-foreground">
        {t('providerSettings.sourceUnavailable')}
      </p>
    )
  if (!profile.fileSources) return null
  const overridden = hasFileOverrides(profile)
  return (
    <details data-testid="provider-file-sources" className="space-y-2 text-sm" open={overridden}>
      <summary className="cursor-pointer rounded-sm text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus">
        {t('providerSettings.sourceTitle')}
      </summary>
      <p className="text-muted-foreground">
        {t(overridden ? 'providerSettings.sourceOverrideHelp' : 'providerSettings.sourceHelp')}
      </p>
      <dl className="grid gap-x-6 gap-y-2 sm:grid-cols-2">
        {Object.entries(fields).map(([field, label]) => {
          const sources = profile.fileSources?.[field]
          if (!Array.isArray(sources)) return null
          const known = sources.filter(source => layers.has(source))
          return (
            <div key={field} className="min-w-0">
              <dt className="text-muted-foreground">
                {t(
                  field === 'reasoning_policy'
                    ? 'localRuntime:providerSettings.reasoningPolicy'
                    : `providerSettings.${label}`
                )}
              </dt>
              <dd className="break-words text-foreground">
                {known.length
                  ? known.map(source => t(`providerSettings.sourceLayer_${source}`)).join(' · ')
                  : t('providerSettings.sourceUnknown')}
              </dd>
            </div>
          )
        })}
      </dl>
    </details>
  )
}
