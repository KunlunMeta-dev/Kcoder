import { GatewayRpcError, type GatewayServer } from './gatewayRpc'
import type { GatewayClient, OwnedGatewayConnection } from './gatewayRuntimeTypes'
import { workspacePathKey } from '@/lib/workspace-path-identity'

export async function restartOwnedAppServers(
  targets: OwnedGatewayConnection[],
  force: boolean,
  release: (client: GatewayClient) => void,
  reconnect: (server: GatewayServer, workspacePath?: string) => Promise<GatewayClient>
): Promise<{ restarted: boolean; requiresConfirmation: boolean }> {
  if (targets.length === 0) return { restarted: false, requiresConfirmation: false }
  await Promise.all(targets.map(target => target.ready))
  const workspaces = new Map<string, OwnedGatewayConnection[]>()
  for (const target of targets) {
    const key = `${target.serverId}\0${workspacePathKey(target.workspacePath)}`
    const clients = workspaces.get(key) ?? []
    clients.push(target)
    workspaces.set(key, clients)
  }
  let restarted = false
  for (const clients of workspaces.values()) {
    const requester = clients.find(target => !target.nativeManagementOnly)
    for (const extra of clients) {
      if (extra === requester) continue
      // Socket close is not a broker ownership barrier. Await the self-only detach ACK.
      const result = await extra.client.request<{ detached?: boolean }>('gateway/client/detach', {
        confirm: true,
        force,
      })
      if (result.detached !== true) throw new Error('KCoder client detach was not acknowledged')
      release(extra.client)
    }
    if (!requester) continue
    let result: { stopped?: boolean; reconnectRequired?: boolean }
    try {
      result = await requester.client.request('gateway/app-server/restart', { confirm: true, force })
    } catch (error) {
      if (error instanceof GatewayRpcError && error.code === -32043)
        return { restarted, requiresConfirmation: true }
      throw error
    }
    if (result.stopped !== true || result.reconnectRequired !== true) {
      throw new Error('KCoder app-server stop was not acknowledged')
    }
    release(requester.client)
    // connectClient resolves only after the new initialize handshake, not on WebSocket open.
    const probe = await reconnect(requester.server, requester.workspacePath)
    release(probe)
    restarted = true
  }
  return { restarted, requiresConfirmation: false }
}
