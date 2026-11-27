import { sha256 } from '@noble/hashes/sha2.js'
import { bytesToHex } from '@noble/hashes/utils.js'
import { getRuntimeConfig } from '@/config/runtime'
import { hookTargetScope } from './gatewayHookConfiguration'
import type { GatewayServer } from './gatewayRpc'

/** A cache namespace, not authority. Relay mounts may share one browser origin. */
export function migrationSourceRecoveryScope(target: GatewayServer): string {
  return bytesToHex(sha256(new TextEncoder().encode(JSON.stringify([
    getRuntimeConfig().appBasePath, hookTargetScope(target),
  ]))))
}
