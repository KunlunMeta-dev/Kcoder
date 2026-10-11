import type { GatewayServer } from './gatewayRpc'

export const HOOK_CONFIGURATION_CAPABILITY = 'hookConfigurationV1'
export const HOOK_CONFIGURATION_READ = 'runtime.hooks.configuration.read'
export const HOOK_CONFIGURATION_UPDATE = 'runtime.hooks.configuration.update'
export interface HookConfiguration {
  hooks: unknown
  revision: string
  configurationPath: string
  appliesToNewConversations: boolean
}
/** A guard against dispatching an old editor draft through a new target/account context. */
export function hookTargetScope(server: GatewayServer): string {
  return JSON.stringify([
    server.id,
    server.transport,
    server.host,
    server.port,
    server.user,
    server.command,
    server.workspacePath,
    server.profile,
    server.settingsFile,
    server.security?.identity.mode,
    server.authorityId,
    server.accountIdentity?.principalId,
  ])
}
