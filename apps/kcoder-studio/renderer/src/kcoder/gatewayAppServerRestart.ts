import type { GatewayServer } from './gatewayRpc'
import type { GatewayClient } from './gatewayRuntimeTypes'

export interface OwnedRuntimeClient {
  client: GatewayClient
  server: GatewayServer
  workspacePath?: string
  ready: Promise<void>
}

export async function restartOwnedAppServers(
  targets: OwnedRuntimeClient[],
  force: boolean,
  release: (client: GatewayClient) => Promise<void>,
  reconnect: (server: GatewayServer, workspacePath?: string) => Promise<GatewayClient>
): Promise<boolean> {
  if (targets.length === 0) return false
  await Promise.all(targets.map(target => target.ready))
  const workspaces = new Map<string, OwnedRuntimeClient[]>()
  for (const target of targets) {
    const key = `${target.server.id}\0${target.workspacePath ?? ''}`
    const clients = workspaces.get(key) ?? []
    clients.push(target)
    workspaces.set(key, clients)
  }
  for (const [requester, ...extras] of workspaces.values()) {
    for (const extra of extras) {
      // Socket close is not a broker ownership barrier. Await the self-only detach ACK.
      const result = await extra.client.request<{ detached?: boolean }>('gateway/client/detach', {
        confirm: true,
        force,
      })
      if (result.detached !== true) throw new Error('KCoder client detach was not acknowledged')
      await release(extra.client)
      extra.client.close()
    }
    const result = await requester.client.request<{
      stopped?: boolean
      reconnectRequired?: boolean
    }>('gateway/app-server/restart', { confirm: true, force })
    if (result.stopped !== true || result.reconnectRequired !== true) {
      throw new Error('KCoder app-server stop was not acknowledged')
    }
    await release(requester.client)
    requester.client.close()
    // connectClient resolves only after the new initialize handshake, not on WebSocket open.
    const probe = await reconnect(requester.server, requester.workspacePath)
    try {
      await release(probe)
    } finally {
      probe.close()
    }
  }
  return true
}
