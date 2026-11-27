import type { IntegrationTaskCapabilitySourceDescriptor } from '../../../shared/generated/contracts'
import { isIntegrationTaskCapabilitySourceChoice } from '../../../shared/generated/contractGuards.mjs'
import type { ConnectionList } from '@/features/connectivity/types'
import { sourceChoice, sourceChoiceKey } from '@/features/connectivity/task-capability-scope-selection'

export interface TaskCapabilitySourceObservation {
  installation: 'installed' | 'not_applicable' | 'unknown'
  globallyEnabled: boolean | null
  connection: 'ready' | 'unavailable' | 'timedOut' | 'unknown'
  validation: 'verified' | 'unverified' | 'unknown'
}
type Source = NonNullable<ConnectionList['sources']>[number]
type Reader = (method: 'mcp/list' | 'plugin/list') => Promise<unknown>
const record = (value: unknown): Record<string, unknown> | undefined => value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined
const selector = (value: Record<string, unknown>) => typeof value.name === 'string' && (value.pluginId === undefined || value.pluginId === null || typeof value.pluginId === 'string') ? JSON.stringify([value.name, value.pluginId ?? null]) : undefined
function exactSource(page: ConnectionList, key: string): Source | undefined {
  if (page.sourcesState !== 'observed' || !Array.isArray(page.sources)) return
  const matches = page.sources.filter(value => isIntegrationTaskCapabilitySourceChoice(value.taskSourceChoice) && sourceChoiceKey(value.taskSourceChoice) === key)
  return matches.length === 1 ? matches[0] : undefined
}

/** Observations never resolve an old binding by a display name or grant execution. */
export async function readTaskCapabilitySourceObservations(descriptors: IntegrationTaskCapabilitySourceDescriptor[], connections: () => Promise<ConnectionList>, read: Reader): Promise<Record<string, TaskCapabilitySourceObservation>> {
  const before = await connections()
  const diagnostics = await Promise.allSettled([read('mcp/list'), descriptors.some(value => value.kind === 'plugin_mcp') ? read('plugin/list') : Promise.resolve(undefined)])
  const after = await connections()
  const mcp = diagnostics[0].status === 'fulfilled' ? record(diagnostics[0].value) : undefined
  const plugins = diagnostics[1].status === 'fulfilled' ? record(diagnostics[1].value) : undefined
  const result: Record<string, TaskCapabilitySourceObservation> = {}
  for (const descriptor of descriptors) {
    if (descriptor.state !== 'ready') continue
    const key = sourceChoiceKey(sourceChoice(descriptor)), original = exactSource(before, key), current = exactSource(after, key)
    if (!original || !current || selector(original) !== selector(current) || original.enabled !== current.enabled || original.authorization !== current.authorization) continue
    const servers = Array.isArray(mcp?.servers) ? mcp.servers.map(record).filter(value => value && selector(value) === selector(current)) : []
    const server = servers.length === 1 ? servers[0] : undefined
    const installed = Array.isArray(plugins?.plugins) ? plugins.plugins.map(record).filter(value => value?.id === current.pluginId) : []
    const plugin = installed.length === 1 ? installed[0] : undefined
    result[key] = {
      installation: current.pluginId === null ? 'not_applicable' : plugin ? 'installed' : 'unknown',
      globallyEnabled: server && (server.enabled === undefined || typeof server.enabled === 'boolean') && (current.pluginId === null || typeof plugin?.enabled === 'boolean') ? server.enabled !== false && (plugin?.enabled ?? true) === true : null,
      connection: server && ['ready', 'unavailable', 'timedOut'].includes(String(server.lastConnectionAttempt)) ? server.lastConnectionAttempt as TaskCapabilitySourceObservation['connection'] : 'unknown',
      validation: 'unknown',
    }
  }
  return result
}
