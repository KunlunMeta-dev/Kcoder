import type { GatewayClient } from '../../gatewayRuntimeTypes'

const active = new WeakMap<GatewayClient, Map<string, Set<symbol>>>()
const keyFor = (taskId: string, turnId: string) => JSON.stringify([taskId, turnId])

/** An App request registers only its independent interaction row, never a model turn. */
export function registerMcpAppOperation(
  client: GatewayClient,
  taskId: string,
  operationId: unknown
) {
  if (typeof operationId !== 'string' || !operationId || operationId.length > 256)
    throw new Error('MCP App operations require a bounded stable identity')
  let scopes = active.get(client)
  if (!scopes) {
    scopes = new Map()
    active.set(client, scopes)
  }
  const key = keyFor(taskId, `mcp-app-${operationId}`)
  if (!scopes.has(key) && scopes.size >= 128)
    throw new Error('MCP App operation scope budget reached')
  const owners = scopes.get(key) ?? new Set<symbol>()
  const owner = Symbol('mcp-app-operation')
  owners.add(owner)
  scopes.set(key, owners)
  return () => {
    owners.delete(owner)
    if (owners.size === 0 && scopes.get(key) === owners) scopes.delete(key)
  }
}

export function isMcpAppOperation(client: GatewayClient, taskId: string, turnId: string) {
  return (active.get(client)?.get(keyFor(taskId, turnId))?.size ?? 0) > 0
}
