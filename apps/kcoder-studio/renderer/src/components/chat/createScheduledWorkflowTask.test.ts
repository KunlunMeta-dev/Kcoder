import { beforeEach, expect, test, vi } from 'vitest'
import { createScheduledWorkflowTask, type ScheduledWorkflowChoice } from './createScheduledWorkflowTask'
import { KnowledgeOperationError } from '@/features/knowledge-integration/client'
const fixture = vi.hoisted(() => ({ request: vi.fn(), preview: vi.fn(), save: vi.fn(), dispose: vi.fn() }))
vi.mock('@/host/localExecutor', () => ({ requestLocalExecutor: fixture.request }))
vi.mock('@/features/runtime-governance/knowledgeTransport', () => ({ nativeKnowledgeTransport: () => ({}) }))
vi.mock('@/features/knowledge-integration/client', async original => ({
  ...(await original<typeof import('@/features/knowledge-integration/client')>()),
  KnowledgeIntegrationClient: class {
    previewSubscription = fixture.preview
    saveSubscription = fixture.save
    dispose = fixture.dispose
  },
}))
const flags = { memoryCenterEnabled: true, publicationsEnabled: false, businessAutomationEnabled: true }
const settings = { effective: flags, connection: flags, persisted: flags, revision: 'a'.repeat(64), restartRequired: false }
const scope = { accountId: 'owned', targetId: 'local', workspaceId: '/owned', identityGeneration: '1', targetRevision: '1' }
const workflow: ScheduledWorkflowChoice = {
  id: 'saved', version: 3, title: 'Saved workflow', isCurrent: () => true,
  definition: { id: 'saved', savedVersion: 3, inputSchema: { type: 'object', properties: { focus: { type: 'string', default: 'summary' } } } } as ScheduledWorkflowChoice['definition'],
}
const input = { address: { deviceId: 'local', workspacePath: '/owned' }, workflow, title: 'Daily report',
  schedule: { kind: 'cron' as const, expression: '0 9 * * *' }, timezone: 'Asia/Shanghai', isCurrent: () => true }
beforeEach(() => {
  vi.clearAllMocks()
  fixture.request.mockImplementation(async (_method, params) => params.method === 'integrations/scope/read' ? scope : settings)
  fixture.preview.mockResolvedValue({ nextFireAtMs: 2_000_000_000_000 })
  fixture.save.mockResolvedValue({ subscription: {} })
})
test('uses the shared schedule and fixed saved workflow defaults with Studio delivery', async () => {
  await createScheduledWorkflowTask(input)
  expect(fixture.preview).toHaveBeenCalledOnce()
  const draft = fixture.preview.mock.calls[0][0]
  expect(draft).toMatchObject({ title: 'Daily report', workflowId: 'saved', workflowVersion: 3,
    inputs: { focus: 'summary' }, schedule: { kind: 'cron', expression: '0 9 * * *' },
    maximumTokens: 1_000_000, maximumRuntimeSeconds: 300, delivery: { kind: 'studio' }, eventSource: null })
  expect(fixture.save).toHaveBeenCalledExactlyOnceWith(draft)
  expect(fixture.dispose).toHaveBeenCalledOnce()
})
test('owner change after preview prevents saving on another target', async () => {
  let current = true
  fixture.preview.mockImplementationOnce(async () => { current = false; return {} })
  await expect(createScheduledWorkflowTask({ ...input, isCurrent: () => current })).rejects.toThrow(KnowledgeOperationError)
  expect(fixture.save).not.toHaveBeenCalled()
})
test('an uncertain save is never replayed automatically', async () => {
  const error = new KnowledgeOperationError('OUTCOME_UNKNOWN', 'original-operation', true)
  fixture.save.mockRejectedValueOnce(error)
  await expect(createScheduledWorkflowTask(input)).rejects.toBe(error)
  expect(fixture.save).toHaveBeenCalledOnce()
  expect(fixture.dispose).toHaveBeenCalledOnce()
})
