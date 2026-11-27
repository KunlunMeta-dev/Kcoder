import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, expect, test, vi } from 'vitest'
import { NativeTaskCapabilityScopeSettings } from './NativeTaskCapabilityScopeSettings'
import { requestLocalExecutor } from '@/host/localExecutor'
import type { IntegrationTaskCapabilityScopeSnapshot } from '../../../../shared/generated/contracts'
vi.mock('@/host/localExecutor', () => ({ requestLocalExecutor: vi.fn() }))
vi.mock('@/kcoder/usePluginTargetScope', () => ({ usePluginTargetScope: () => ({ key: 'owned-scope', isCurrent: () => true }) }))
vi.mock('@/hooks/useTranslation', () => ({ useTranslation: () => ({ i18n: { language: 'en' } }) }))
const execute = vi.mocked(requestLocalExecutor), owner = { serverId: 'local', workspacePath: '/owned-workspace' }
const scope = { accountId: 'owned', targetId: 'target', workspaceId: 'workspace', identityGeneration: '1', targetRevision: '1' }
const target = { initialAttempt: { threadId: 'original-thread', turnId: 'original-turn', attemptId: 'original-attempt' } }
const snapshot: IntegrationTaskCapabilityScopeSnapshot = { threadId: 'original-thread', revision: 1, selection: { mode: 'inherit_current', sources: [] }, effectiveSources: [], effectiveFrom: 'current_snapshot' }
const descriptor = { sourceRef: { id: 'native-source', revision: 'real-security-revision' }, accountRef: null, kind: 'mcp', displayName: 'Actual registered source', accountDisplayName: null, state: 'ready', reasonCode: null, capabilities: ['tools'] }
function reply(request: Record<string, unknown>, result: unknown) { return { contractVersion: 'parallel-v1', requestId: request.requestId, operationId: request.operationId ?? null, entityRevision: null, status: 'completed', observedAt: '2026-10-25T00:00:00Z', result, error: null } }
beforeEach(() => { execute.mockReset(); sessionStorage.clear() })
test('a real catalog enables explicit selection and forwards original target plus native CAS', async () => {
  execute.mockImplementation(async (_name, raw) => { const call = raw as { method: string; params: Record<string, unknown> }; if (call.method === 'integrations/scope/read') return scope
    if (call.method.endsWith('/readTaskSources')) return reply(call.params, snapshot)
    if (call.method.endsWith('/listTaskSourceChoices')) return reply(call.params, { target, catalogRevision: 'actual-catalog', catalogState: 'observed', items: [descriptor], nextCursor: null })
    const payload = call.params.payload as { params: { selection: unknown } }
    return reply(call.params, { snapshot: { ...snapshot, revision: 3, selection: payload.params.selection, effectiveFrom: 'next_tool_boundary' }, operation: { operationId: call.params.operationId, scope, port: 'P-TASK', method: 'setTaskSources', revision: 3, phase: 'completed', createdAtMs: 1, updatedAtMs: 2, entityRef: null, error: null } }) })
  render(<NativeTaskCapabilityScopeSettings target={owner} original={target} snapshot={snapshot} />)
  fireEvent.click(screen.getByRole('button', { name: 'Set task tools and resource scope' }))
  expect(await screen.findByText('Actual registered source')).toBeInTheDocument()
  fireEvent.click(screen.getByRole('radio', { name: 'Selected tool providers only' }))
  fireEvent.click(screen.getByRole('checkbox')); fireEvent.click(screen.getByRole('button', { name: 'Save task tools and resource scope' }))
  await waitFor(() => expect(execute.mock.calls.some(([, value]) => (value as { method: string }).method.endsWith('/setTaskSources'))).toBe(true))
  const saved = execute.mock.calls.find(([, value]) => (value as { method: string }).method.endsWith('/setTaskSources'))?.[1]
  expect(saved).toMatchObject({ params: { expectedRevision: '1', payload: { target, params: { threadId: 'original-thread', selection: { mode: 'selected', sources: [{ sourceRef: descriptor.sourceRef, accountRef: null }] } } } } })
})
test('unconfirmed catalog retains readonly records and never exposes a pretend save', async () => {
  execute.mockImplementation(async (_name, raw) => { const call = raw as { method: string; params: Record<string, unknown> }; if (call.method === 'integrations/scope/read') return scope
    if (call.method.endsWith('/readTaskSources')) return reply(call.params, snapshot); throw new Error('controlled catalog unavailable') })
  render(<NativeTaskCapabilityScopeSettings target={owner} original={target} snapshot={snapshot} />); fireEvent.click(screen.getByRole('button', { name: 'Set task tools and resource scope' }))
  expect(await screen.findByText('The current tool provider catalog is unconfirmed. Scope settings remain read-only.')).toBeInTheDocument()
  expect(screen.queryByRole('button', { name: 'Save task tools and resource scope' })).not.toBeInTheDocument(); expect(execute.mock.calls.every(([, value]) => !(value as { method: string }).method.endsWith('/setTaskSources'))).toBe(true)
})
test('the normal editor reads native observations without treating a ready descriptor as verification', async () => {
  execute.mockImplementation(async (_name, raw) => {
    const call = raw as { method: string; params: Record<string, unknown>; deviceId?: string; workspacePath?: string }
    if (call.method === 'integrations/scope/read') return scope
    if (call.method.endsWith('/readTaskSources')) return reply(call.params, snapshot)
    if (call.method.endsWith('/listTaskSourceChoices')) return reply(call.params, { target, catalogRevision: 'actual-catalog', catalogState: 'observed', items: [descriptor], nextCursor: null })
    if (call.method.endsWith('/listConnections')) return reply(call.params, { items: [], nextCursor: null, catalog: { applications: [], channels: [] }, sourcesState: 'observed', sources: [{ name: 'Actual registered source', pluginId: null, enabled: true, authorization: 'notApplicable', taskSourceChoice: { sourceRef: descriptor.sourceRef, accountRef: null } }] })
    if (call.method === 'mcp/list') { expect(call.deviceId).toBe('local'); expect(call.workspacePath).toBe(owner.workspacePath); return { servers: [{ name: 'Actual registered source', transport: 'stdio', authorization: 'notApplicable', lastConnectionAttempt: 'ready' }] } }
    throw Error('unexpected mutation')
  })
  render(<NativeTaskCapabilityScopeSettings target={owner} original={target} snapshot={snapshot} />)
  fireEvent.click(screen.getByRole('button', { name: 'Set task tools and resource scope' }))
  expect(await screen.findByText('Last connection: Ready')).toBeInTheDocument()
  expect(screen.getByText('Installed: Not applicable (direct MCP)')).toBeInTheDocument()
  expect(screen.getByText('Global: Enabled')).toBeInTheDocument(); expect(screen.getByText('Business check: Not verified')).toBeInTheDocument()
  expect(execute.mock.calls.every(([, value]) => !String((value as { method: string }).method).endsWith('/setTaskSources'))).toBe(true)
})
