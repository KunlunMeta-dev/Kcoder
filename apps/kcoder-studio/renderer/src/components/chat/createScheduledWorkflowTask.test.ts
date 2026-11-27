import { beforeEach, expect, test, vi } from 'vitest'
import {
  createScheduledWorkflowTask,
  readScheduledWorkflowCreation,
  type ScheduledWorkflowChoice,
} from './createScheduledWorkflowTask'
import { KnowledgeOperationError } from '@/features/knowledge-integration/client'
import type {
  IntegrationRequest,
  AutomationSubscription,
} from '../../../../shared/generated/contracts'
import type { WorkflowCreationLocator } from '@/kcoder/automationCreationPending'
const fixture = vi.hoisted(() => ({ request: vi.fn() }))
vi.mock('@/host/localExecutor', () => ({ requestLocalExecutor: fixture.request }))
const flags = {
  memoryCenterEnabled: true,
  publicationsEnabled: false,
  businessAutomationEnabled: true,
}
const settings = {
  effective: flags,
  connection: flags,
  persisted: flags,
  revision: 'a'.repeat(64),
  restartRequired: false,
}
const scope = {
  accountId: 'owned',
  targetId: 'local',
  workspaceId: '/owned',
  identityGeneration: '1',
  targetRevision: '1',
}
const owner = {
  accountId: scope.accountId,
  targetId: scope.targetId,
  workspaceId: scope.workspaceId,
}
const workflow: ScheduledWorkflowChoice = {
  id: 'saved',
  version: 3,
  title: 'Saved workflow',
  isCurrent: () => true,
  definition: {
    id: 'saved',
    savedVersion: 3,
    inputSchema: { type: 'object', properties: { focus: { type: 'string', default: 'summary' } } },
  } as ScheduledWorkflowChoice['definition'],
}
const input = {
  address: { deviceId: 'local', workspacePath: '/owned' },
  workflow,
  title: 'Daily report',
  schedule: { kind: 'cron' as const, expression: '0 9 * * *' },
  timezone: 'Asia/Shanghai',
  isCurrent: () => true,
  onPrepared: vi.fn(),
}
function reply(request: IntegrationRequest, result: unknown, status = 'completed') {
  return {
    contractVersion: 'parallel-v1',
    requestId: request.requestId,
    operationId: request.operationId ?? null,
    status,
    entityRevision: null,
    observedAt: '2026-11-19T00:00:00Z',
    result,
    error: null,
  }
}
let saved: AutomationSubscription | undefined
let saveMode: 'completed' | 'lost' | 'accepted' = 'completed'
beforeEach(() => {
  saved = undefined
  saveMode = 'completed'
  vi.clearAllMocks()
  fixture.request.mockReset().mockImplementation(async (_method, params) => {
    if (params.method === 'integrations/scope/read') return scope
    if (params.method === 'settings/integrations/knowledge/read') return settings
    const request = params.params as IntegrationRequest
    if (params.method === 'integrations/automation/previewSubscription')
      return reply(request, { nextFireAtMs: 2_000_000_000_000 })
    if (params.method === 'integrations/automation/saveSubscription') {
      expect(input.onPrepared).toHaveBeenCalledOnce()
      saved = {
        owner,
        draft: structuredClone(request.payload.draft) as AutomationSubscription['draft'],
        consentRef: request.payload.consentRef as string,
        enabled: true,
        revision: 1,
        createdAtMs: 1000,
        updatedAtMs: 1000,
      }
      if (saveMode === 'lost') throw new Error('lost reply')
      return reply(request, { subscription: saved }, saveMode)
    }
    if (params.method === 'integrations/automation/listSubscriptions')
      return reply(request, { page: { items: saved ? [saved] : [], nextCursor: null } })
    throw new Error('Unexpected request')
  })
})
test('prepares the original identity before dispatch and uses the shared saved workflow defaults', async () => {
  await createScheduledWorkflowTask(input)
  const locator = input.onPrepared.mock.calls[0][0] as WorkflowCreationLocator
  expect(saved).toMatchObject({
    consentRef: locator.operationId,
    draft: {
      id: locator.subscriptionId,
      title: 'Daily report',
      workflowId: 'saved',
      workflowVersion: 3,
      inputs: { focus: 'summary' },
      schedule: input.schedule,
      maximumTokens: 1_000_000,
      maximumRuntimeSeconds: 300,
      delivery: { kind: 'studio' },
      eventSource: null,
    },
  })
  const writes = fixture.request.mock.calls.filter(([, params]) =>
    params.method.endsWith('/saveSubscription')
  )
  expect(writes).toHaveLength(1)
  expect(writes[0][1].params.operationId).toBe(locator.operationId)
})
test('owner change after preview prevents preparation and saving on another target', async () => {
  let current = true
  const send = fixture.request.getMockImplementation()!
  fixture.request.mockImplementation(async (...args) => {
    const result = await send(...args)
    if (args[1].method.endsWith('/previewSubscription')) current = false
    return result
  })
  await expect(createScheduledWorkflowTask({ ...input, isCurrent: () => current })).rejects.toThrow(
    KnowledgeOperationError
  )
  expect(input.onPrepared).not.toHaveBeenCalled()
  expect(saved).toBeUndefined()
})
test('failed locator persistence prevents the subscription mutation', async () => {
  await expect(
    createScheduledWorkflowTask({
      ...input,
      onPrepared: () => {
        throw new Error('storage unavailable')
      },
    })
  ).rejects.toThrow('storage unavailable')
  expect(saved).toBeUndefined()
})
test('a lost save reply is reconciled from the saved subscription without replay', async () => {
  saveMode = 'lost'
  await expect(createScheduledWorkflowTask(input)).rejects.toMatchObject({ uncertain: true })
  const locator = input.onPrepared.mock.calls[0][0] as WorkflowCreationLocator
  expect(await readScheduledWorkflowCreation(input.address, locator, input.isCurrent)).toBe(true)
  expect(
    fixture.request.mock.calls.filter(([, params]) => params.method.endsWith('/saveSubscription'))
  ).toHaveLength(1)
  expect(
    fixture.request.mock.calls.some(([, params]) => params.method === 'integrations/operation/read')
  ).toBe(false)
})
test('accepted is not a completed subscription save even when a draft is returned', async () => {
  saveMode = 'accepted'
  await expect(createScheduledWorkflowTask(input)).rejects.toMatchObject({ uncertain: true })
})
test('absence and a changed consent do not prove original creation completed', async () => {
  await createScheduledWorkflowTask(input)
  const locator = input.onPrepared.mock.calls[0][0] as WorkflowCreationLocator
  saved!.consentRef = 'different-operation'
  expect(await readScheduledWorkflowCreation(input.address, locator, input.isCurrent)).toBe(false)
  saved = undefined
  expect(await readScheduledWorkflowCreation(input.address, locator, input.isCurrent)).toBe(false)
})
test('a different account cannot read an old owner subscription as its receipt', async () => {
  await createScheduledWorkflowTask(input)
  const locator = input.onPrepared.mock.calls[0][0] as WorkflowCreationLocator
  fixture.request.mockClear()
  await expect(
    readScheduledWorkflowCreation(
      input.address,
      { ...locator, owner: { ...owner, accountId: 'other' } },
      input.isCurrent
    )
  ).rejects.toMatchObject({ code: 'KNOWLEDGE_OWNER_CHANGED' })
  expect(fixture.request.mock.calls).toHaveLength(1)
})

test('reconciliation follows native cursors and checks ownership after each page', async () => {
  await createScheduledWorkflowTask(input)
  const locator = input.onPrepared.mock.calls[0][0] as WorkflowCreationLocator
  const send = fixture.request.getMockImplementation()!
  fixture.request.mockImplementation(async (...args) => {
    if (args[1].method.endsWith('/listSubscriptions') && !args[1].params.payload.after)
      return reply(args[1].params, { page: { items: [], nextCursor: 'original-cursor' } })
    return send(...args)
  })
  expect(await readScheduledWorkflowCreation(input.address, locator, input.isCurrent)).toBe(true)
  expect(fixture.request.mock.calls.at(-1)![1].params.payload).toEqual({ after: 'original-cursor' })
  let current = true
  fixture.request.mockImplementation(async (...args) => {
    const result = await send(...args)
    if (args[1].method.endsWith('/listSubscriptions')) current = false
    return result
  })
  await expect(
    readScheduledWorkflowCreation(input.address, locator, () => current)
  ).rejects.toMatchObject({ code: 'KNOWLEDGE_OWNER_CHANGED' })
})
test('a repeated cursor stops reconciliation without treating absence as rejection', async () => {
  await createScheduledWorkflowTask(input)
  const locator = input.onPrepared.mock.calls[0][0] as WorkflowCreationLocator
  const send = fixture.request.getMockImplementation()!
  fixture.request.mockImplementation(async (...args) =>
    args[1].method.endsWith('/listSubscriptions')
      ? reply(args[1].params, { page: { items: [], nextCursor: 'repeated-cursor' } })
      : send(...args)
  )
  await expect(
    readScheduledWorkflowCreation(input.address, locator, input.isCurrent)
  ).rejects.toMatchObject({ code: 'KNOWLEDGE_INVALID_RECEIPT' })
  expect(
    fixture.request.mock.calls.filter(([, params]) => params.method.endsWith('/listSubscriptions'))
  ).toHaveLength(2)
})
test('a save reply for a different subscription remains uncertain', async () => {
  const send = fixture.request.getMockImplementation()!
  fixture.request.mockImplementation(async (...args) => {
    const result = await send(...args)
    if (args[1].method.endsWith('/saveSubscription'))
      result.result.subscription.draft.id = 'wrong-subscription'
    return result
  })
  await expect(createScheduledWorkflowTask(input)).rejects.toMatchObject({
    uncertain: true,
    code: 'KNOWLEDGE_INVALID_RECEIPT',
  })
})
