import type { NativeStartupDiagnostic } from '../../../../shared/nativeStartupDiagnostic.mjs'
import { useTranslation } from '@/hooks/useTranslation'

export function StartupDiagnosticDetails({ diagnostic }: { diagnostic: NativeStartupDiagnostic }) {
  const { t } = useTranslation('localRuntime')
  const launch = diagnostic.launch
  if (!launch) return null
  return <dl className="my-3 space-y-2 text-left text-xs text-text-secondary" data-testid="startup-launch-details">
    {launch.command && <div><dt>{t('startup_command')}</dt><dd className="break-all font-mono">{launch.command}</dd></div>}
    <div><dt>{t('startup_command_source')}</dt><dd>{t(`startup_command_sources.${launch.commandSource}`)}</dd></div>
    {launch.settingsFile && <div><dt>{t('startup_settings_file')}</dt><dd className="break-all font-mono">{launch.settingsFile}</dd></div>}
    {launch.profile && <div><dt>{t('startup_profile')}</dt><dd>{launch.profile}</dd></div>}
  </dl>
}
