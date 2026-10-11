import type { TFunction } from 'i18next'
import type { GatewayServerConfig } from './gatewayRpc'

/** Translate application-owned names only; configured labels are user data. */
export function gatewayServerLabel(
  server: Pick<GatewayServerConfig, 'id' | 'label' | 'labelKey' | 'transport'>,
  t: TFunction
): string {
  return server.labelKey === 'currentComputer' && server.transport === 'local'
    ? t('common:runtimeTarget.currentComputer')
    : server.label || server.id
}

/** Only synthesized project names carry this translation provenance. */
export function runtimeProjectLabel(project: { name: string; nameKey?: 'currentComputer' }, t: TFunction): string {
  return project.nameKey === 'currentComputer' ? t('common:runtimeTarget.currentComputer') : project.name
}
