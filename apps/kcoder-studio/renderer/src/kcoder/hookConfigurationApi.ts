import { requestLocalExecutor } from '@/tauri/localExecutor'
import type { GatewayServer } from './gatewayRpc'
import {
  HOOK_CONFIGURATION_READ,
  HOOK_CONFIGURATION_UPDATE,
  hookTargetScope,
  type HookConfiguration,
} from './gatewayHookConfiguration'
export function readHookConfiguration(target: GatewayServer) {
  return requestLocalExecutor<HookConfiguration>(HOOK_CONFIGURATION_READ, {
    deviceId: target.id,
    targetScope: hookTargetScope(target),
  })
}
export function updateHookConfiguration(
  target: GatewayServer,
  hooks: unknown,
  expectedRevision: string
) {
  return requestLocalExecutor<HookConfiguration>(HOOK_CONFIGURATION_UPDATE, {
    deviceId: target.id,
    targetScope: hookTargetScope(target),
    hooks,
    expectedRevision,
  })
}
