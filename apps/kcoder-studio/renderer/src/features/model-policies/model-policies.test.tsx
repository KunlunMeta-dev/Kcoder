// Contract-only backend fixtures exercise the actual LocalExecutor consumer and Gateway whitelist.
// Actual native FD/transactions/HTTP behavior is covered by registered app-server stdio tests.
import { afterEach, beforeAll, beforeEach, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import i18n from 'i18next'
import { initReactI18next } from 'react-i18next'
import type {
  IntegrationScope,
  IntegrationRequest,
  IntegrationOperationReceipt,
  IntegrationModelPolicyDefinition,
  IntegrationModelPolicySettingsSnapshot,
} from '../../../../shared/generated/contracts'
import { requestNativeIntegration } from '@/kcoder/gatewayIntegrations'
import { connectModelPolicies, ModelPolicyError } from '@/kcoder/modelPolicies'
import { NativeModelPolicyWorkspace } from './NativeModelPolicyWorkspace'
import { modelPolicyResources } from './locales'
const mock = vi.hoisted(() => ({ request: vi.fn(), isCurrent: () => true }))
vi.mock('@/host/localExecutor', () => ({ requestLocalExecutor: mock.request }))
vi.mock('@/kcoder/usePluginTargetScope', () => ({
  usePluginTargetScope: (serverId: string, workspacePath?: string) => ({
    key: JSON.stringify([serverId, workspacePath]),
    isCurrent: mock.isCurrent,
  }),
}))
const policy = (title = 'Approved pool'): IntegrationModelPolicyDefinition => ({
  id: 'user-configured-pool',
  title,
  enabled: true,
  candidates: [{ provider: 'ConfiguredA', model: 'one', enabled: true }],
})
const configured = [
  { provider: 'ConfiguredA', model: 'one', available: true, configurationRevision: 'a'.repeat(64) },
  { provider: 'ConfiguredB', model: 'two', available: true, configurationRevision: 'b'.repeat(64) },
]
const reference = { id: 'user-configured-pool', version: 'a'.repeat(64) }
function scope(server: string): IntegrationScope {
  return {
    accountId: `account-${server}`,
    targetId: `native-${server}`,
    workspaceId: 'owned-workspace',
    identityGeneration: 'epoch1',
    targetRevision: 'config1',
  }
}
function receipt(
  owner: IntegrationScope,
  operationId: string,
  phase: IntegrationOperationReceipt['phase'],
  revision = '1'.repeat(64)
): IntegrationOperationReceipt {
  return {
    scope: structuredClone(owner),
    operationId,
    port: 'model-policy-settings',
    method: 'savePolicies',
    phase,
    revision: 3,
    createdAtMs: 1,
    updatedAtMs: 2,
    error: null,
    entityRef:
      phase === 'completed'
        ? { kind: 'model_policy_configuration', id: owner.accountId, revision }
        : null,
  }
}
function backend(server = 'host') {
  return {
    taskModelsSupported: true,
    scope: scope(server),
    snapshot: {
      revision: '0'.repeat(64),
      policies: [policy(`${server} policy`)],
      models: configured,
      modelsTruncated: false,
    } as IntegrationModelPolicySettingsSnapshot,
    calls: [] as { method: string; fields: IntegrationRequest }[],
    operation: null as IntegrationOperationReceipt | null,
    lost: false,
    completeBeforeLoss: false,
    healthSupported: true,
    usageSupported: true,
    settingsUnavailable: false,
    scopeWait: undefined as Promise<IntegrationScope> | undefined,
  }
}
let active: Record<string, ReturnType<typeof backend>>
function previewResult() {
  return {
    selectionKind: 'auto_policy',
    policyRef: reference,
    budget: { reservationState: 'not_reserved', costKnown: false },
    model: {
      providerId: 'ConfiguredA',
      modelId: 'one',
      apiFormat: 'openai_chat_completions',
      chatProtocol: 'auto',
      contextWindowTokens: 128000,
      maxOutputTokens: 128,
      requestOutputLimits: { max_tokens: 128 },
      outputHeadroomTokens: 128,
      text: true,
      tools: true,
      toolSet: { profile: 'full', registryScope: 'profile_configuration' },
      vision: false,
      reasoning: false,
      structuredOutput: true,
      reasoningEffort: null,
      extraBodyConfigured: false,
      requestOverrideFields: [],
      revision: 'a'.repeat(64),
      boundary: 'next_turn',
      sources: {},
    },
  }
}
async function nativeRequest(server: string, method: string, fields: IntegrationRequest) {
  const state = active[server]
  if (method === 'integrations/scope/read') return state.scopeWait ?? structuredClone(state.scope)
  state.calls.push({ method, fields: structuredClone(fields) })
  let result: unknown
  if (method.endsWith('/readPolicies'))
    result = {
      policies: state.snapshot.policies.map(policy => ({
        reference: { id: policy.id, version: reference.version },
        title: policy.title,
        enabled: policy.enabled,
        candidates: policy.candidates,
      })),
    }
  else if (method.endsWith('/resolveSelection')) result = previewResult()
  else if (method.endsWith('/readHealth')) result = { policyRef: reference, observations: [] }
  else if (method.endsWith('/readUsage'))
    result = {
      policyRef: reference,
      observations: [
        {
          provider: 'ConfiguredA',
          model: 'one',
          configurationRevision: 'a'.repeat(64),
          lastObservedAt: '2026-10-25T00:00:00Z',
          reportedInputTokens: 111,
          reportedOutputTokens: 23,
          reportedTotalTokens: 134,
          reportedCacheReadInputTokens: 0,
          reportedCacheCreationInputTokens: null,
          complete: false,
        },
      ],
    }
  else if (method.endsWith('/settings/read')) {
    if (state.settingsUnavailable) throw new Error('Owned current metadata unavailable')
    result = state.snapshot
  } else if (method.endsWith('/settings/readOperation')) result = { receipt: state.operation }
  else if (method.endsWith('/settings/save')) {
    state.snapshot = {
      ...state.snapshot,
      revision: '1'.repeat(64),
      policies: structuredClone(fields.payload.policies) as IntegrationModelPolicyDefinition[],
    }
    state.operation = receipt(
      state.scope,
      fields.operationId!,
      state.lost && !state.completeBeforeLoss ? 'executing' : 'completed'
    )
    if (state.lost) throw new Error('Owned simulated ACK loss after admission')
    result = { operation: state.operation, current: state.snapshot }
  } else throw new Error('Unexpected finite fixture method')
  return {
    contractVersion: 'parallel-v1',
    requestId: fields.requestId,
    operationId: fields.operationId ?? null,
    entityRevision: null,
    observedAt: '2026-10-25T00:00:00Z',
    status: 'completed',
    error: null,
    result: structuredClone(result),
  }
}
beforeAll(async () => {
  await i18n.use(initReactI18next).init({
    lng: 'en',
    fallbackLng: 'en',
    resources: {
      en: { modelPolicies: modelPolicyResources.en },
      'zh-CN': { modelPolicies: modelPolicyResources['zh-CN'] },
    },
    interpolation: { escapeValue: false },
  })
})
beforeEach(() => {
  sessionStorage.clear()
  active = { host: backend('host'), second: backend('second') }
  const runtime = {
    disposed: false,
    workspaceScanGeneration: 0,
    configurationEpochByTarget: new Map<string, number>(),
    assertCommandTarget: async () => undefined,
    serverForParams: async ({ deviceId }: { deviceId: string }) => ({
      id: deviceId,
      name: deviceId,
      transport: 'local',
      workspacePath: '/owned-workspace',
    }),
    commandClient: async (server: { id: string }) => ({
      supportsExperimental: (capability: string) =>
        (capability !== 'modelHealthV1' || active[server.id].healthSupported) &&
        (capability !== 'modelUsageV1' || active[server.id].usageSupported) &&
        (capability !== 'automationTaskModelsV1' || active[server.id].taskModelsSupported),
      request: (method: string, fields: IntegrationRequest) =>
        nativeRequest(server.id, method, fields),
    }),
  }
  mock.request.mockReset()
  mock.request.mockImplementation((name, params, options) => {
    expect(name).toBe('runtime.integrations.request')
    return requestNativeIntegration.call(runtime as never, params, options)
  })
})
afterEach(() => {
  cleanup()
  sessionStorage.clear()
})
const target = { serverId: 'host', workspacePath: '/owned-workspace' }
it('an independent task model capability is required before a subscription can read or select Auto', async () => {
  active.host.taskModelsSupported = false
  render(
    <NativeModelPolicyWorkspace
      target={{ ...target, requiredCapability: 'automationTaskModelsV1' }}
      allowEdit={false}
    />
  )
  await screen.findByText('Update the selected target to use this capability.')
  expect(screen.queryByRole('combobox', { name: 'Choose a policy' })).toBeNull()
  expect(active.host.calls).toHaveLength(0)
})
it('subscription policy reads and previews retain the independent target capability without settings writes', async () => {
  const selected = vi.fn()
  render(
    <NativeModelPolicyWorkspace
      target={{ ...target, requiredCapability: 'automationTaskModelsV1' }}
      allowEdit={false}
      onSelect={selected}
    />
  )
  fireEvent.change(await screen.findByRole('combobox', { name: 'Choose a policy' }), {
    target: { value: JSON.stringify([reference.id, reference.version]) },
  })
  fireEvent.click(screen.getByRole('button', { name: 'Preview candidate' }))
  fireEvent.click(await screen.findByRole('button', { name: 'Use this policy' }))
  expect(selected).toHaveBeenCalledWith({ kind: 'auto_policy', ...reference })
  expect(
    mock.request.mock.calls.every(
      ([, params]) => params.requiredCapability === 'automationTaskModelsV1'
    )
  ).toBe(true)
  expect(active.host.calls.map(call => call.method)).toEqual([
    'integrations/models/readPolicies',
    'integrations/models/resolveSelection',
  ])
})
it('reads real finite Gateway methods but never picks the first pool or overwrites manual choice', async () => {
  const selected = vi.fn()
  render(
    <NativeModelPolicyWorkspace
      target={target}
      value={{ kind: 'explicit', provider: 'ConfiguredB', model: 'two' }}
      allowEdit={false}
      onSelect={selected}
    />
  )
  const chooser = await screen.findByRole('combobox', { name: 'Choose a policy' })
  expect((chooser as HTMLSelectElement).value).toBe('')
  expect(screen.getByRole('button', { name: 'Preview candidate' })).toBeDisabled()
  expect(selected).not.toHaveBeenCalled()
  fireEvent.change(chooser, {
    target: { value: JSON.stringify([reference.id, reference.version]) },
  })
  fireEvent.click(screen.getByRole('button', { name: 'Preview candidate' }))
  await screen.findByText('Candidate from this preview: ConfiguredA / one')
  expect(selected).not.toHaveBeenCalled()
  fireEvent.click(screen.getByRole('button', { name: 'Use this policy' }))
  expect(selected).toHaveBeenCalledWith({ kind: 'auto_policy', ...reference })
  expect(active.host.calls.filter(call => call.method.endsWith('/settings/save'))).toHaveLength(0)
})
it('creates and orders a user pool with no implicit candidate, then saves one original operation', async () => {
  active.host.snapshot.policies = []
  render(<NativeModelPolicyWorkspace target={target} />)
  fireEvent.click(await screen.findByRole('button', { name: 'Add pool' }))
  fireEvent.change(screen.getByRole('textbox', { name: 'Pool name' }), {
    target: { value: 'User chosen order' },
  })
  fireEvent.click(screen.getByRole('button', { name: 'Add candidate' }))
  let candidates = screen.getAllByRole('combobox', { name: 'Configured provider and model' })
  expect((candidates[0] as HTMLSelectElement).value).toBe('["",""]')
  fireEvent.change(candidates[0], { target: { value: '["ConfiguredA","one"]' } })
  fireEvent.click(screen.getByRole('button', { name: 'Add candidate' }))
  candidates = screen.getAllByRole('combobox', { name: 'Configured provider and model' })
  fireEvent.change(candidates[1], { target: { value: '["ConfiguredB","two"]' } })
  fireEvent.click(screen.getAllByRole('button', { name: 'Move earlier' })[1])
  fireEvent.click(screen.getByRole('button', { name: 'Save pools' }))
  await screen.findByText('The original save receipt confirms this configuration was saved.')
  const saves = active.host.calls.filter(call => call.method.endsWith('/settings/save'))
  expect(saves).toHaveLength(1)
  expect(
    (saves[0].fields.payload.policies as IntegrationModelPolicyDefinition[])[0].candidates.map(
      candidate => candidate.provider
    )
  ).toEqual(['ConfiguredB', 'ConfiguredA'])
  expect(saves[0].fields.expectedRevision).toBe('0'.repeat(64))
})
it('lost save ACK plus different peer content keeps original unknown and never repeats save', async () => {
  active.host.lost = true
  render(<NativeModelPolicyWorkspace target={target} />)
  fireEvent.change(await screen.findByRole('textbox', { name: 'Pool name' }), {
    target: { value: 'My intended title' },
  })
  fireEvent.click(screen.getByRole('button', { name: 'Save pools' }))
  await screen.findByText(
    'The save outcome is unconfirmed. Check its original receipt before making another change.'
  )
  active.host.snapshot = {
    ...active.host.snapshot,
    revision: '2'.repeat(64),
    policies: [policy('Peer different policy')],
  }
  fireEvent.click(screen.getByRole('button', { name: 'Check original save' }))
  await screen.findByText('The original operation has not confirmed a final outcome.')
  expect(screen.getByRole('button', { name: 'Save pools' })).toBeDisabled()
  expect(
    screen.queryByText('The original save receipt confirms this configuration was saved.')
  ).toBeNull()
  expect(active.host.calls.filter(call => call.method.endsWith('/settings/save'))).toHaveLength(1)
})
it('completed original receipt and later peer change are shown separately after ACK loss', async () => {
  active.host.lost = true
  active.host.completeBeforeLoss = true
  render(<NativeModelPolicyWorkspace target={target} />)
  fireEvent.change(await screen.findByRole('textbox', { name: 'Pool name' }), {
    target: { value: 'Originally saved title' },
  })
  fireEvent.click(screen.getByRole('button', { name: 'Save pools' }))
  await screen.findByRole('button', { name: 'Check original save' })
  await waitFor(() => expect(active.host.operation?.phase).toBe('completed'))
  active.host.snapshot = {
    ...active.host.snapshot,
    revision: '2'.repeat(64),
    policies: [policy('Current peer title')],
  }
  fireEvent.click(screen.getByRole('button', { name: 'Check original save' }))
  await screen.findByText('The original save completed, and the configuration has since changed.')
  expect((screen.getByRole('textbox', { name: 'Pool name' }) as HTMLInputElement).value).toBe(
    'Current peer title'
  )
  expect(active.host.calls.filter(call => call.method.endsWith('/settings/save'))).toHaveLength(1)
})
it('late prior target metadata cannot replace the selected target view', async () => {
  let deliver!: (value: IntegrationScope) => void
  active.host.scopeWait = new Promise(resolve => {
    deliver = resolve
  })
  const view = render(<NativeModelPolicyWorkspace target={target} allowEdit={false} />)
  view.rerender(<NativeModelPolicyWorkspace target={{ serverId: 'second' }} allowEdit={false} />)
  await screen.findByRole('option', { name: 'second policy' })
  deliver(scope('host'))
  await Promise.resolve()
  expect(screen.queryByRole('option', { name: 'host policy' })).toBeNull()
  expect(active.host.calls).toHaveLength(0)
})
it('locked verification is never replaced by the ordinary AUTO picker', async () => {
  const selected = vi.fn()
  render(
    <NativeModelPolicyWorkspace
      target={target}
      value={{
        kind: 'verifier_locked',
        provider: 'ConfiguredA',
        model: 'one',
        configurationRevision: 'a'.repeat(64),
      }}
      allowEdit={false}
      onSelect={selected}
    />
  )
  const chooser = await screen.findByRole('combobox', { name: 'Choose a policy' })
  fireEvent.change(chooser, {
    target: { value: JSON.stringify([reference.id, reference.version]) },
  })
  fireEvent.click(screen.getByRole('button', { name: 'Preview candidate' }))
  await screen.findByText('Candidate from this preview: ConfiguredA / one')
  expect(screen.queryByRole('button', { name: 'Use this policy' })).toBeNull()
  expect(selected).not.toHaveBeenCalled()
})
it('old hosts can preview policies without claiming independent health support', async () => {
  active.host.healthSupported = false
  render(<NativeModelPolicyWorkspace target={target} allowEdit={false} />)
  fireEvent.change(await screen.findByRole('combobox', { name: 'Choose a policy' }), {
    target: { value: JSON.stringify([reference.id, reference.version]) },
  })
  fireEvent.click(screen.getByRole('button', { name: 'Read observations' }))
  await screen.findByText('This target does not provide provider health observations.')
  expect(active.host.calls.some(call => call.method.endsWith('/readHealth'))).toBe(false)
})
it('pending original save can be read after configuration epoch refresh, but a foreign owner cannot be accepted', async () => {
  const signal = new AbortController().signal
  const first = await connectModelPolicies(target, () => true, signal)
  active.host.lost = true
  await expect(
    first.save([policy()], '0'.repeat(64), 'stable-original-op', signal)
  ).rejects.toBeInstanceOf(ModelPolicyError)
  first.dispose()
  active.host.scope = {
    ...active.host.scope,
    identityGeneration: 'epoch2',
    targetRevision: 'config2',
  }
  const current = await connectModelPolicies(target, () => true, signal)
  expect(current.pendingOperation()).toBe('stable-original-op')
  expect((await current.operation('stable-original-op', signal))?.phase).toBe('executing')
  active.host.operation!.scope.accountId = 'foreign-profile'
  await expect(current.operation('stable-original-op', signal)).rejects.toMatchObject({
    code: 'invalid',
  })
  current.dispose()
})

it('a confirmed original receipt stays confirmed when current configuration becomes unreadable', async () => {
  active.host.lost = true
  active.host.completeBeforeLoss = true
  render(<NativeModelPolicyWorkspace target={target} />)
  fireEvent.change(await screen.findByRole('textbox', { name: 'Pool name' }), {
    target: { value: 'Known original save' },
  })
  fireEvent.click(screen.getByRole('button', { name: 'Save pools' }))
  await screen.findByText(
    'The save outcome is unconfirmed. Check its original receipt before making another change.'
  )
  active.host.settingsUnavailable = true
  fireEvent.click(screen.getByRole('button', { name: 'Check original save' }))
  await screen.findByText(
    'The original save completed. Its current configuration cannot be read yet.'
  )
  expect(screen.getByRole('button', { name: 'Save pools' })).toBeDisabled()
  expect(screen.queryByRole('button', { name: 'Check original save' })).toBeNull()
  expect(active.host.calls.filter(call => call.method.endsWith('/settings/save'))).toHaveLength(1)
})

it('reports actual provided counters as partial and preserves an explicit cache zero', async () => {
  render(<NativeModelPolicyWorkspace target={target} allowEdit={false} />)
  fireEvent.change(await screen.findByRole('combobox', { name: 'Choose a policy' }), {
    target: { value: JSON.stringify([reference.id, reference.version]) },
  })
  fireEvent.click(screen.getByRole('button', { name: 'Read reported usage' }))
  await screen.findByText('Partial or unknown report')
  expect(screen.getByText('Input tokens: 111 · Output tokens: 23')).toBeVisible()
  expect(screen.getByText('Total tokens: 134 · Cache-read input tokens: 0')).toBeVisible()
  expect(screen.queryByText('Complete report confirmed')).toBeNull()
  expect(active.host.calls.filter(call => call.method.endsWith('/readUsage'))).toHaveLength(1)
})
it('reported usage has an independent capability and never fabricates zero on old hosts', async () => {
  active.host.usageSupported = false
  render(<NativeModelPolicyWorkspace target={target} allowEdit={false} />)
  fireEvent.change(await screen.findByRole('combobox', { name: 'Choose a policy' }), {
    target: { value: JSON.stringify([reference.id, reference.version]) },
  })
  fireEvent.click(screen.getByRole('button', { name: 'Read reported usage' }))
  await screen.findByText('This target does not provide reported usage observations.')
  expect(active.host.calls.some(call => call.method.endsWith('/readUsage'))).toBe(false)
  expect(screen.queryByText('Input tokens: 0')).toBeNull()
})
