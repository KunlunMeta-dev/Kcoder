import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import { KCoderGatewayRuntime } from './gatewayRuntime'
import { FakeGatewayClient } from './gateway/runtime/contractFixture.test-support'
import { notifyAccountContextChange } from './accountContextEvents'
import { clearTestTransports, installTestTransport } from '@/test/runtime-transport'

const runtimes = new Set<KCoderGatewayRuntime>()

test('task model intent and policy reads require the independent capability, preserving omitted legacy fields', async () => {
  const { runtime, client, request } = fixture()
  const supported = vi
    .spyOn(client, 'supportsExperimental')
    .mockImplementation(name => name !== 'automationTaskModelsV1')
  const fields = envelope()
  fields.payload = {
    draft: { modelSelection: { kind: 'auto_policy', id: 'fixed-pool', version: 'fixed-version' } },
  }
  await expect(
    runtime.request('runtime.integrations.request', {
      serverId: 'local',
      method: 'integrations/automation/previewSubscription',
      params: fields,
    })
  ).rejects.toThrow('UPGRADE_REQUIRED')
  await expect(
    runtime.request('runtime.integrations.request', {
      serverId: 'local',
      method: 'integrations/models/readPolicies',
      requiredCapability: 'automationTaskModelsV1',
      params: envelope(),
    })
  ).rejects.toThrow('UPGRADE_REQUIRED')
  expect(request.mock.calls.filter(([method]) => method.startsWith('integrations/'))).toHaveLength(
    0
  )
  await expect(
    runtime.request('runtime.integrations.request', {
      serverId: 'local',
      method: 'integrations/automation/previewSubscription',
      params: envelope(),
    })
  ).resolves.toMatchObject({ status: 'completed' })
  supported.mockReturnValue(true)
  await expect(
    runtime.request('runtime.integrations.request', {
      serverId: 'local',
      method: 'integrations/automation/previewSubscription',
      params: fields,
    })
  ).resolves.toMatchObject({ status: 'completed' })
  expect(request).toHaveBeenLastCalledWith('integrations/automation/previewSubscription', fields)
})
const scope = {
  accountId: 'account',
  targetId: 'target',
  workspaceId: 'workspace',
  identityGeneration: 'generation',
  targetRevision: 'configuration',
}
const envelope = () => ({
  contractVersion: 'parallel-v1',
  requestId: 'request',
  scope,
  operationId: undefined,
  expectedRevision: undefined,
  timeoutMs: 1000,
  payload: {},
})
const reply = (params: Record<string, unknown>) => ({
  contractVersion: 'parallel-v1',
  requestId: params.requestId,
  status: 'completed',
  operationId: params.operationId ?? null,
  entityRevision: null,
  observedAt: '2026-10-24T00:00:00Z',
  result: { page: { items: [], nextCursor: null } },
  error: null,
})
function fixture() {
  const client = new FakeGatewayClient(null)
  const fallback = client.request.bind(client)
  const request = vi
    .spyOn(client, 'request')
    .mockImplementation(async (method, params = {}) =>
      method === 'integrations/scope/read'
        ? scope
        : method.startsWith('integrations/')
          ? reply(params)
          : fallback(method, params)
    )
  const runtime = new KCoderGatewayRuntime('synthetic-test-token', {
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
  runtimes.add(runtime)
  return { runtime, client, request, fallback }
}
beforeEach(() => {
  localStorage.clear()
  installTestTransport(() => undefined)
})
afterEach(async () => {
  await Promise.all([...runtimes].map(runtime => runtime.disposeAsync()))
  runtimes.clear()
  vi.restoreAllMocks()
  clearTestTransports()
})

test('integration controls require an explicit target and forward only registered native methods', async () => {
  const { runtime, request } = fixture()
  await expect(
    runtime.request('runtime.integrations.request', { method: 'integrations/scope/read' })
  ).rejects.toThrow('TARGET_REQUIRED')
  await expect(
    runtime.request('runtime.integrations.request', {
      serverId: 'local',
      method: 'private.integration.call',
    })
  ).rejects.toThrow('METHOD_UNSUPPORTED')
  expect(request).not.toHaveBeenCalled()
  await expect(
    runtime.request('runtime.integrations.request', {
      serverId: 'local',
      method: 'integrations/scope/read',
      params: {},
    })
  ).resolves.toEqual(scope)
  const result = await runtime.request('runtime.integrations.request', {
    serverId: 'local',
    method: 'integrations/memory/list',
    params: envelope(),
  })
  expect(result).toMatchObject({ status: 'completed', result: { page: { items: [] } } })
  const sent = request.mock.calls.find(call => call[0] === 'integrations/memory/list')![1]!
  expect(Object.hasOwn(sent, 'operationId')).toBe(false)
  expect(Object.hasOwn(sent, 'expectedRevision')).toBe(false)
})

test('unavailable native capability rejects before forwarding and never falls back to another target', async () => {
  const { runtime, client, request } = fixture()
  vi.spyOn(client, 'supportsExperimental').mockReturnValue(false)
  await expect(
    runtime.request('runtime.integrations.request', {
      serverId: 'local',
      method: 'integrations/memory/list',
      params: envelope(),
    })
  ).rejects.toThrow('UPGRADE_REQUIRED')
  expect(request).not.toHaveBeenCalledWith(
    'integrations/memory/list',
    expect.anything(),
    expect.anything()
  )
})

test('model preflight requires its own negotiated capability and cannot activate a model', async () => {
  const { runtime, client, request } = fixture()
  const supports = vi
    .spyOn(client, 'supportsExperimental')
    .mockImplementation(capability => capability !== 'modelPoliciesV1')
  for (const method of [
    'integrations/models/readPolicies',
    'integrations/models/resolveSelection',
  ]) {
    await expect(
      runtime.request('runtime.integrations.request', {
        serverId: 'local',
        method,
        params: envelope(),
      })
    ).rejects.toThrow('UPGRADE_REQUIRED')
    expect(request).not.toHaveBeenCalledWith(method, expect.anything(), expect.anything())
  }
  supports.mockImplementation(capability => capability !== 'modelHealthV1')
  await expect(
    runtime.request('runtime.integrations.request', {
      serverId: 'local',
      method: 'integrations/models/readHealth',
      params: envelope(),
    })
  ).rejects.toThrow('UPGRADE_REQUIRED')
  expect(request).not.toHaveBeenCalledWith(
    'integrations/models/readHealth',
    expect.anything(),
    expect.anything()
  )
  supports.mockReturnValue(true)
  await expect(
    runtime.request('runtime.integrations.request', {
      serverId: 'local',
      method: 'integrations/models/readPolicies',
      params: envelope(),
    })
  ).resolves.toMatchObject({ status: 'completed' })
  await expect(
    runtime.request('runtime.integrations.request', {
      serverId: 'local',
      method: 'integrations/models/activate',
      params: envelope(),
    })
  ).rejects.toThrow('METHOD_UNSUPPORTED')
  expect(request).not.toHaveBeenCalledWith(
    'integrations/models/activate',
    expect.anything(),
    expect.anything()
  )
})

test('late integration results after account invalidation are discarded without replay', async () => {
  const { runtime, request, fallback } = fixture()
  let complete!: (value: unknown) => void
  let begun!: () => void
  const started = new Promise<void>(resolve => {
    begun = resolve
  })
  request.mockImplementation(async (method, params = {}) => {
    if (method !== 'integrations/memory/list') return fallback(method, params)
    begun()
    return new Promise(resolve => {
      complete = value => resolve(value ?? reply(params))
    })
  })
  const pending = runtime.request('runtime.integrations.request', {
    serverId: 'local',
    method: 'integrations/memory/list',
    params: envelope(),
  })
  await started
  notifyAccountContextChange('local')
  complete(null)
  // The shared connection fence may reject before this domain's own fence.
  await expect(pending).rejects.toThrow(/OWNER_CHANGED|Workspace scan invalidated/)
  expect(request.mock.calls.filter(call => call[0] === 'integrations/memory/list')).toHaveLength(1)
})

test('contradictory success or mismatched request identity is not a confirmed result', async () => {
  const { runtime, request } = fixture()
  request.mockImplementation(async (_method, params = {}) => ({
    ...reply(params),
    requestId: 'different-request',
  }))
  await expect(
    runtime.request('runtime.integrations.request', {
      serverId: 'local',
      method: 'integrations/memory/list',
      params: envelope(),
    })
  ).rejects.toThrow('REPLY_INVALID')
  request.mockImplementation(async (_method, params = {}) => ({
    ...reply(params),
    error: { code: 'RESOURCE_DENIED', recovery: 'none', messageKey: 'integration.denied' },
  }))
  await expect(
    runtime.request('runtime.integrations.request', {
      serverId: 'local',
      method: 'integrations/memory/list',
      params: envelope(),
    })
  ).rejects.toThrow('REPLY_INVALID')
})

test('knowledge and automation require separately negotiated capabilities without a private Port fallback', async () => {
  const { runtime, client, request } = fixture()
  const supported = vi.spyOn(client, 'supportsExperimental').mockReturnValue(true)
  for (const method of [
    'integrations/knowledge/readPublicationSources',
    'integrations/automation/listTemplates',
  ]) {
    await expect(
      runtime.request('runtime.integrations.request', {
        serverId: 'local',
        method,
        params: envelope(),
      })
    ).resolves.toMatchObject({ status: 'completed' })
    expect(request).toHaveBeenCalledWith(method, expect.anything())
  }
  supported.mockImplementation(name => name !== 'knowledgePublicationsV1')
  const before = request.mock.calls.length
  await expect(
    runtime.request('runtime.integrations.request', {
      serverId: 'local',
      method: 'integrations/knowledge/listPublications',
      params: envelope(),
    })
  ).rejects.toThrow('UPGRADE_REQUIRED')
  expect(request.mock.calls).toHaveLength(before)
  await expect(
    runtime.request('runtime.integrations.request', {
      serverId: 'local',
      method: 'integrations/automation/triggerApprovedSubscription',
      params: envelope(),
    })
  ).rejects.toThrow('METHOD_UNSUPPORTED')
})

test('period budgets need their own negotiated flag while omitted legacy budgets keep the original route', async () => {
  const { runtime, client, request } = fixture()
  const supported = vi
    .spyOn(client, 'supportsExperimental')
    .mockImplementation(name => name !== 'automationPeriodBudgetsV1')
  const fields = envelope()
  fields.payload = {
    draft: { periodBudget: { windowSeconds: 86400, maximumTokens: 5000, maximumModelCalls: 8 } },
  }
  await expect(
    runtime.request('runtime.integrations.request', {
      serverId: 'local',
      method: 'integrations/automation/previewSubscription',
      params: fields,
    })
  ).rejects.toThrow('UPGRADE_REQUIRED')
  expect(request.mock.calls.filter(([method]) => method.startsWith('integrations/'))).toHaveLength(
    0
  )
  await expect(
    runtime.request('runtime.integrations.request', {
      serverId: 'local',
      method: 'integrations/automation/previewSubscription',
      params: envelope(),
    })
  ).resolves.toMatchObject({ status: 'completed' })
  supported.mockReturnValue(true)
  await expect(
    runtime.request('runtime.integrations.request', {
      serverId: 'local',
      method: 'integrations/automation/previewSubscription',
      params: fields,
    })
  ).resolves.toMatchObject({ status: 'completed' })
})

test('explicit task resources require their separately negotiated capability before mutation dispatch', async () => {
  const { runtime, client, request } = fixture()
  const support = vi
    .spyOn(client, 'supportsExperimental')
    .mockImplementation(name => name !== 'taskResourceBindingsV1')
  const params = {
    ...envelope(),
    operationId: 'original-resource-change',
    expectedRevision: '1',
    payload: {
      target: { initialAttempt: { threadId: 'thread', turnId: 'turn', attemptId: 'attempt' } },
      params: {
        threadId: 'thread',
        selection: { mode: 'none', sources: [] },
        resourceBindings: [],
      },
    },
  }
  await expect(
    runtime.request('runtime.integrations.request', {
      serverId: 'local',
      method: 'integrations/tasks/setTaskSources',
      params,
    })
  ).rejects.toThrow('UPGRADE_REQUIRED')
  expect(
    request.mock.calls.filter(call => call[0] === 'integrations/tasks/setTaskSources')
  ).toHaveLength(0)
  support.mockReturnValue(true)
  await expect(
    runtime.request('runtime.integrations.request', {
      serverId: 'local',
      method: 'integrations/tasks/setTaskSources',
      params,
    })
  ).resolves.toMatchObject({ status: 'completed' })
  expect(
    request.mock.calls.filter(call => call[0] === 'integrations/tasks/setTaskSources')
  ).toHaveLength(1)
})

test('ordinary ACK never reaches an old Native without its independent receipt capability', async () => {
  const { runtime, client, request } = fixture()
  vi.spyOn(client, 'supportsExperimental').mockImplementation(
    name => name !== 'officeExportReceiptV1'
  )
  const fields = {
    ...envelope(),
    operationId: 'original-byte-ack',
    payload: {
      exportId: 'original-export',
      leaseRevision: 'original-lease',
      reference: { id: 'original-artifact', revision: 1 },
      bytes: 10,
      sha256: 'a'.repeat(64),
    },
  }
  await expect(
    runtime.request('runtime.integrations.request', {
      serverId: 'local',
      method: 'integrations/artifact/acknowledgeExport',
      params: fields,
    })
  ).rejects.toThrow('UPGRADE_REQUIRED')
  expect(
    request.mock.calls.filter(([method]) => method === 'integrations/artifact/acknowledgeExport')
  ).toHaveLength(0)
  expect(
    request.mock.calls.filter(([method]) => method === 'integrations/artifact/export')
  ).toHaveLength(0)
})

test.each(['capabilities', 'prepare', 'read', 'current', 'start', 'stop', 'renew', 'revoke'])(
  'retired channel service %s has no runtime forwarding route', async kind => {
    const { runtime, request } = fixture()
    await expect(runtime.request('runtime.integrations.request', {
      serverId: 'local', method: `integrations/services/channel/${kind}`, params: envelope(),
    })).rejects.toThrow('INTEGRATION_METHOD_UNSUPPORTED')
    expect(request).not.toHaveBeenCalled()
  }
)
