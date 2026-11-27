import type { TFunction } from 'i18next'
export function deviceDisplayName(
  device: { name?: string | null; device_id: string; nameKey?: 'currentComputer' },
  t: TFunction
): string {
  return device.nameKey === 'currentComputer'
    ? t('common:runtimeTarget.currentComputer')
    : device.name || device.device_id
}
