import i18n from '@/i18n'
import {
  readInlineWidgetsEnabled,
  studioWorkMode,
  type StudioWorkMode,
} from '@/features/workbench/studioWorkMode'
import type { GatewayClient } from './gatewayRuntimeTypes'

export function studioCreationParams(params: Record<string, unknown>, client: GatewayClient) {
  const mode = studioWorkMode(params.studioWorkMode)
  if (params.sessionMode && params.sessionMode !== 'default') return {}
  if (mode === 'kworker' && !client.supportsExperimental?.('studioWorkModesV1'))
    throw new Error(i18n.t('workbench.work_mode.unsupported'))
  return client.supportsExperimental?.('studioWorkModesV1') ? { studioWorkMode: mode } : {}
}

export function studioPresentationParams(mode: StudioWorkMode | undefined, client: GatewayClient) {
  const workMode = studioWorkMode(mode)
  if (!client.supportsExperimental?.('studioWorkModesV1')) {
    if (workMode === 'kworker') throw new Error(i18n.t('workbench.work_mode.unsupported'))
    return {}
  }
  const inlineWidgets = workMode === 'kworker' && readInlineWidgetsEnabled() &&
    client.supportsExperimental?.('inlineWidgetsV1') === true
  return {
    clientPresentation: {
      version: 1,
      studioWorkMode: workMode,
      inlineWidgets,
      ...(inlineWidgets &&
        client.supportsExperimental?.('isolatedWidgetsV1') === true ? { isolatedWidgets: true } : {}),
    },
  }
}
