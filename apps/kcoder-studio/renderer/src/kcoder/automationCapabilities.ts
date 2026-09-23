import i18n from '@/i18n'
import type { GatewayClient } from './gatewayRuntimeTypes'

export function assertAutomationCapabilities(
  client: GatewayClient,
  method: string,
  fields: Record<string, unknown>
): void {
  if (client.supportsExperimental?.('projectAutomations') !== true)
    throw new Error(i18n.t('automations.targetUnsupported'))
  if (method === 'cron/preview' && client.supportsExperimental?.('cronPreviewV1') !== true)
    throw new Error(i18n.t('automations.previewUnsupported'))
  const schedule = fields.schedule
  if (
    method === 'cron/create' &&
    schedule &&
    typeof schedule === 'object' &&
    'kind' in schedule &&
    schedule.kind === 'zoned_cron' &&
    client.supportsExperimental?.('cronTimezoneV1') !== true
  )
    throw new Error(i18n.t('automations.timezoneUnsupported'))
}
