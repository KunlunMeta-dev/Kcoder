import { clearMocks } from '@tauri-apps/api/mocks'
import { afterEach, expect, test, vi } from 'vitest'
import { FakeGatewayClient } from './gateway/runtime/contractFixture.test-support'
import { KCoderGatewayRuntime } from './gatewayRuntime'
const runtimes: KCoderGatewayRuntime[] = []
afterEach(async () => {
  await Promise.all(runtimes.splice(0).map(runtime => runtime.disposeAsync()))
  clearMocks()
  vi.restoreAllMocks()
})
function setup(blocked?: string) {
  const client = new FakeGatewayClient(null)
  vi.spyOn(client, 'supportsExperimental').mockImplementation(capability => capability !== blocked)
  const request = vi.spyOn(client, 'request').mockResolvedValue({ result: 'wire' })
  const runtime = new KCoderGatewayRuntime('token', {
    loadServers: async () => [
      {
        id: 'local',
        label: 'Local',
        description: '',
        transport: 'local',
        workspacePath: '/workspace',
      },
    ],
    createClient: () => client,
  })
  runtimes.push(runtime)
  return { runtime, request }
}
test('version verification/storage/history require explicit advertised capabilities', async () => {
  for (const [capability, method] of [
    ['workflowVerificationV1', 'workflow/verification/read'],
    ['workflowStorageV1', 'workflow/storage/read'],
    ['workflowVersionHistoryV1', 'workflow/versions/references'],
    ['workflowRunArchiveV1', 'workflow/runs/archive/preview'],
    ['workflowRunArchiveV1', 'workflow/runs/archive/list'],
  ]) {
    const { runtime, request } = setup(capability)
    await expect(
      runtime.request('runtime.workflows.request', {
        serverId: 'local',
        method,
        params: { id: 'workflow', version: 1 },
      })
    ).rejects.toThrow()
    expect(request).not.toHaveBeenCalledWith(method, expect.anything())
  }
})
test('reads preserve exact version/page scope and storage mutations require explicit confirmation', async () => {
  const { runtime, request } = setup()
  const params = { id: 'workflow', version: 7, offset: 32, limit: 16 }
  await runtime.request('runtime.workflows.request', {
    serverId: 'local',
    method: 'workflow/verification/read',
    params,
  })
  expect(request).toHaveBeenCalledWith('workflow/verification/read', params)
  for (const method of [
    'workflow/storage/migrate',
    'workflow/storage/rollback',
    'workflow/versions/archive',
    'workflow/runs/archive',
  ]) {
    await expect(
      runtime.request('runtime.workflows.request', {
        serverId: 'local',
        method,
        params: { id: 'workflow', version: 1, expectedRevision: 8 },
      })
    ).rejects.toThrow()
    expect(request).not.toHaveBeenCalledWith(method, expect.anything())
  }
  const confirmed = { id: 'workflow', version: 1, expectedRevision: 8, confirm: true }
  await runtime.request('runtime.workflows.request', {
    serverId: 'local',
    method: 'workflow/versions/archive',
    params: confirmed,
  })
  expect(request).toHaveBeenCalledWith('workflow/versions/archive', confirmed)
})
test('older targets get a full read without unsupported conditional fields and inputs are not mutated', async () => {
  const { runtime, request } = setup('workflowConditionalReadV1')
  const params = { id: 'workflow', knownRevision: 9, knownUpdatedAtMs: 10 }
  await runtime.request('runtime.workflows.request', {
    serverId: 'local',
    method: 'workflow/read',
    params,
  })
  expect(request).toHaveBeenCalledWith('workflow/read', { id: 'workflow' })
  expect(params).toEqual({ id: 'workflow', knownRevision: 9, knownUpdatedAtMs: 10 })
  await runtime.request('runtime.workflows.request', {
    serverId: 'local',
    method: 'workflow/runs/read',
    params: { runId: 'run', knownRevision: 3 },
  })
  expect(request).toHaveBeenCalledWith('workflow/runs/read', { runId: 'run' })
})
test('capability status comes from initialize flags without probing unsupported RPCs', async () => {
  const { runtime, request } = setup('workflowVerificationScenariosV1')
  const result = await runtime.request('runtime.workflows.request', {
    serverId: 'local',
    method: 'workflow/capabilities/read',
    params: {},
  })
  expect(result).toEqual({
    verification: true,
    storage: true,
    versionHistory: true,
    scenarios: false,
    conditionalRead: true,
    runArchive: true,
  })
  expect(request).not.toHaveBeenCalledWith('workflow/capabilities/read', expect.anything())
})

test('run archive carries the selected IDs and preview token without selecting or replaying runs', async () => {
  const { runtime, request } = setup()
  const selected = { runIds: ['run-a', 'run-b'] }
  await runtime.request('runtime.workflows.request', {
    serverId: 'local',
    method: 'workflow/runs/archive/preview',
    params: selected,
  })
  expect(request).toHaveBeenCalledWith('workflow/runs/archive/preview', selected)
  const confirmed = { ...selected, previewToken: 'a'.repeat(64), confirm: true }
  await runtime.request('runtime.workflows.request', {
    serverId: 'local',
    method: 'workflow/runs/archive',
    params: confirmed,
  })
  expect(request).toHaveBeenCalledWith('workflow/runs/archive', confirmed)
})
