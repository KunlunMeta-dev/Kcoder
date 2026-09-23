import type { GatewayClient } from './gatewayRuntimeTypes'
import type { RuntimeExecutionModes } from '@/types/api'

export function executionModeParams(
  params: Record<string, unknown>,
  client: GatewayClient
): RuntimeExecutionModes {
  const { sessionMode, turnMode } = params
  if (sessionMode != null && sessionMode !== 'default' && sessionMode !== 'orchestrate') {
    throw new Error('Invalid session mode')
  }
  if (
    turnMode != null &&
    (typeof turnMode !== 'string' || !['standard', 'moa', 'moa-plan'].includes(turnMode))
  ) {
    throw new Error('Invalid turn mode')
  }
  if (
    ((sessionMode != null && sessionMode !== 'default') ||
      (turnMode != null && turnMode !== 'standard')) &&
    client.supportsExperimental?.('sessionModes') !== true
  ) {
    throw new Error('目标 KCoder 不支持特殊执行模式，请升级目标后重试')
  }
  return {
    ...(sessionMode ? { sessionMode: sessionMode as RuntimeExecutionModes['sessionMode'] } : {}),
    ...(turnMode ? { turnMode: turnMode as RuntimeExecutionModes['turnMode'] } : {}),
  }
}

export function turnModeParams(params: Record<string, unknown>, client: GatewayClient) {
  const { turnMode } = executionModeParams(params, client)
  return turnMode ? { turnMode } : {}
}
