import { getRuntimeConfig } from '@/config/runtime'
import { isGatewayRuntime } from '@/lib/runtime-environment'

export function isLocalFirstAppRuntime(): boolean {
  return getRuntimeConfig().runtimeMode === 'local-first' && isGatewayRuntime()
}
