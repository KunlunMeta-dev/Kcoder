import { afterEach, expect, test, vi } from 'vitest'
import type { IntegrationRequest, IntegrationScope } from '../../../../shared/generated/contracts'
const fixture = vi.hoisted(() => ({ request: vi.fn(), finite: vi.fn(), current: true }))
vi.mock('@/host/localExecutor', () => ({ requestLocalExecutor: fixture.request }))
vi.mock('../../../../shared/integrationControlMethods.mjs', () => ({
  integrationControlCapability: fixture.finite,
}))
import { nativeOfficeTransport } from './nativeOfficeTransport'
const scope: IntegrationScope = {
  accountId: 'actual-native-account',
  targetId: 'actual-native-target',
  workspaceId: null,
  identityGeneration: '1',
  targetRevision: '1',
}
const request: IntegrationRequest = {
  contractVersion: 'parallel-v1',
  requestId: 'read',
  scope,
  timeoutMs: 1000,
  payload: {},
}
afterEach(() => {
  fixture.request.mockReset()
  fixture.finite.mockReset()
  fixture.current = true
})

test('uses the shared finite Office capability and preserves native target, scope and signal', async () => {
  fixture.finite.mockReturnValue('officeWorkspaceV1')
  fixture.request.mockResolvedValue({
    status: 'completed',
    result: { items: [], nextCursor: null },
  })
  const transport = nativeOfficeTransport(
    { serverId: 'selected-ssh', workspacePath: '/owned-workspace' },
    scope,
    () => fixture.current
  )
  const cancel = new AbortController()
  await transport.call('integrations/assistant/list', request, { signal: cancel.signal })
  expect(fixture.finite).toHaveBeenCalledWith('integrations/assistant/list')
  expect(fixture.request).toHaveBeenCalledWith(
    'runtime.integrations.request',
    {
      serverId: 'selected-ssh',
      workspacePath: '/owned-workspace',
      method: 'integrations/assistant/list',
      params: request,
    },
    { signal: expect.any(AbortSignal) }
  )
  transport.dispose()
})

test('rejects arbitrary methods, foreign scopes and missing real export readers before any write', async () => {
  const transport = nativeOfficeTransport({ serverId: 'target' }, scope, () => true)
  fixture.finite.mockReturnValue(null)
  await expect(transport.call('P-POLICY/evaluateAction', request, {})).rejects.toMatchObject({
    code: 'OFFICE_METHOD_UNSUPPORTED',
  })
  fixture.finite.mockReturnValue('officeWorkspaceV1')
  await expect(
    transport.call(
      'integrations/artifact/read',
      { ...request, scope: { ...scope, accountId: 'foreign' } },
      {}
    )
  ).rejects.toMatchObject({ code: 'OFFICE_SCOPE_CHANGED' })
  await expect(transport.call('integrations/artifact/export', request, {})).rejects.toMatchObject({
    code: 'OFFICE_EXPORT_PROVIDER_UNAVAILABLE',
  })
  expect(transport.prepareInput).toBeUndefined()
  expect(transport.readExport).toBeUndefined()
  expect(fixture.request).not.toHaveBeenCalled()
  transport.dispose()
})

test('cancellation and disposal discard responses even when the underlying transport ignores abort', async () => {
  fixture.finite.mockReturnValue('officeWorkspaceV1')
  let resolve!: (value: unknown) => void
  fixture.request.mockImplementation(
    () =>
      new Promise(done => {
        resolve = done
      })
  )
  const transport = nativeOfficeTransport({ serverId: 'target' }, scope, () => fixture.current)
  const pending = transport.call('integrations/artifact/read', request, {})
  transport.cancelPending()
  expect(fixture.request.mock.calls[0][2].signal.aborted).toBe(true)
  resolve({ result: { privateOldBody: true } })
  await expect(pending).rejects.toThrow()
  transport.dispose()
  await expect(transport.call('integrations/artifact/read', request, {})).rejects.toMatchObject({
    code: 'OFFICE_SCOPE_CHANGED',
  })
})

test('rejects oversized server pages instead of truncating and skipping native cursor data', async () => {
  fixture.finite.mockReturnValue('officeWorkspaceV1')
  fixture.request.mockResolvedValue({
    status: 'completed',
    result: { items: Array.from({ length: 11 }, () => ({})), nextCursor: 'native' },
  })
  const transport = nativeOfficeTransport({ serverId: 'target' }, scope, () => true)
  await expect(transport.call('integrations/artifact/list', request, {})).rejects.toMatchObject({
    code: 'OFFICE_INVALID_REPLY',
  })
  transport.dispose()
})

test('only actual file functions create upload/export hooks and remain owned by current scope', async () => {
  const input = vi.fn(async () => ({ actual: 'receipt' }))
  let finish!: () => void
  const reader = vi.fn(
    () =>
      new Promise<void>(resolve => {
        finish = resolve
      })
  )
  const transport = nativeOfficeTransport({ serverId: 'target' }, scope, () => true, {
    prepareInput: input,
    readExport: reader,
  })
  const file = new File(['material'], 'owned.txt')
  await transport.prepareInput!(file, {
    scope,
    operationId: 'original-upload',
    signal: new AbortController().signal,
    onProgress: vi.fn(),
  })
  expect(input).toHaveBeenCalledWith(
    { serverId: 'target' },
    file,
    expect.objectContaining({ scope, operationId: 'original-upload' })
  )
  const transfer = transport.readExport!({ exportId: 'real-native-export' })
  expect(reader).toHaveBeenCalledWith(
    { exportId: 'real-native-export' },
    expect.objectContaining({ target: { serverId: 'target' }, scope })
  )
  transport.dispose()
  expect(reader.mock.calls[0][1].signal.aborted).toBe(true)
  finish()
  await expect(transfer).rejects.toThrow()
})
