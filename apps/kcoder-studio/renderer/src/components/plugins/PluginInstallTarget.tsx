import { useTranslation } from '@/hooks/useTranslation'

export function PluginInstallTarget({
  deviceId,
  path,
  name,
}: {
  deviceId: string
  path?: string
  name?: string
}) {
  const { t } = useTranslation('common')
  return (
    <details data-testid="plugins-install-target" className="text-xs text-text-secondary">
      <summary className="min-h-8 max-md:min-h-11 cursor-pointer truncate" title={deviceId}>
        {t('workbench.plugins_install_target_summary', { target: name || deviceId })}
      </summary>
      <p className="mt-2 break-all text-xs leading-relaxed">
        {t('workbench.plugins_install_target', { target: deviceId, path: path ?? '' })}
      </p>
    </details>
  )
}
