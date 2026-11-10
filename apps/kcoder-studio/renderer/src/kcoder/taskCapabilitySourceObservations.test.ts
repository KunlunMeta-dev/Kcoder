import { expect, test, vi } from 'vitest'
import { readTaskCapabilitySourceObservations } from './taskCapabilitySourceObservations'
import { sourceChoice, sourceChoiceKey } from '@/features/connectivity/task-capability-scope-selection'
import type { IntegrationTaskCapabilitySourceDescriptor } from '../../../shared/generated/contracts'
import type { ConnectionList } from '@/features/connectivity/types'
const descriptor: IntegrationTaskCapabilitySourceDescriptor = { sourceRef: { id: 'source', revision: 'original' }, accountRef: { id: 'account', revision: 'original' }, kind: 'plugin_mcp', displayName: 'Display label', accountDisplayName: null, state: 'ready', reasonCode: null, capabilities: ['tools'] }
function page(value = descriptor): ConnectionList { return { items: [], nextCursor: null, catalog: { applications: [], channels: [] }, sourcesState: 'observed', sources: [{ name: 'original-server', pluginId: 'original-plugin', enabled: true, authorization: 'authorized', taskSourceChoice: sourceChoice(value) }] } }
const diagnostics = async (method: string) => method === 'mcp/list' ? { servers: [{ name: 'original-server', pluginId: 'original-plugin', authorization: 'authorized', lastConnectionAttempt: 'ready' }] } : { plugins: [{ id: 'original-plugin', enabled: true }] }
test('separate native observations do not turn readiness or installation into business verification', async () => {
  const read = vi.fn(diagnostics), connections = vi.fn(async () => page())
  const result = await readTaskCapabilitySourceObservations([descriptor], connections, read)
  expect(result[sourceChoiceKey(sourceChoice(descriptor))]).toEqual({ installation: 'installed', globallyEnabled: true, connection: 'ready', validation: 'unknown' })
  expect(connections).toHaveBeenCalledTimes(2); expect(read.mock.calls.map(([method]) => method)).toEqual(['mcp/list', 'plugin/list'])
})
test('a source or account revision change while diagnostics wait never transfers observations to the saved binding', async () => {
  for (const changed of [{ ...descriptor, sourceRef: { ...descriptor.sourceRef, revision: 'new' } }, { ...descriptor, accountRef: { id: 'account', revision: 'new' } }]) {
    const connections = vi.fn().mockResolvedValueOnce(page()).mockResolvedValueOnce(page(changed))
    expect(await readTaskCapabilitySourceObservations([descriptor], connections, diagnostics)).toEqual({})
  }
})
test('disabled or same-name unbound sources cannot supply observations for an old source', async () => {
  const current = page(); current.sources![0] = { ...current.sources![0], enabled: false, taskSourceChoice: null }
  expect(await readTaskCapabilitySourceObservations([descriptor], async () => current, diagnostics)).toEqual({})
})
test('a stale task descriptor refuses an older Main summary even when both summary reads retain the old choice', async () => {
  const stale: IntegrationTaskCapabilitySourceDescriptor = { ...descriptor, state: 'unknown', reasonCode: 'NATIVE_SOURCE_REGISTRATION_STALE' }
  expect(await readTaskCapabilitySourceObservations([stale], async () => page(), diagnostics)).toEqual({})
})
test('diagnostic failure retains unknown facts and never infers them from descriptor ready', async () => {
  const result = await readTaskCapabilitySourceObservations([descriptor], async () => page(), async () => { throw Error('unavailable') })
  expect(result[sourceChoiceKey(sourceChoice(descriptor))]).toEqual({ installation: 'unknown', globallyEnabled: null, connection: 'unknown', validation: 'unknown' })
})
test('an ambiguous MCP selector or plugin list does not manufacture installed or enabled facts', async () => {
  const result = await readTaskCapabilitySourceObservations([descriptor], async () => page(), async method => method === 'mcp/list' ? { servers: [{ name: 'original-server', pluginId: 'original-plugin' }, { name: 'original-server', pluginId: 'original-plugin' }] } : { plugins: [{ id: 'original-plugin', enabled: true }, { id: 'original-plugin', enabled: true }] })
  expect(result[sourceChoiceKey(sourceChoice(descriptor))]).toEqual({ installation: 'unknown', globallyEnabled: null, connection: 'unknown', validation: 'unknown' })
})
