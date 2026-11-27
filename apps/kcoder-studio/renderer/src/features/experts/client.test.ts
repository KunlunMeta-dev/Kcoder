import { beforeEach, expect, it, vi } from 'vitest'
import type { IntegrationRequest, IntegrationScope } from '../../../../shared/generated/contracts'
import { ResourceController, ResourceClientError } from '../integration-resources/controller'
import { ExpertClient, newExpert, newExpertFromTemplate } from './client'
const scope: IntegrationScope = {
  accountId: 'owned',
  targetId: 'one',
  workspaceId: null,
  identityGeneration: '1',
  targetRevision: '1',
}
const reply = (request: IntegrationRequest, result: Record<string, unknown>) => ({
  contractVersion: 'parallel-v1',
  requestId: request.requestId,
  operationId: request.operationId ?? null,
  status: 'completed',
  entityRevision: null,
  observedAt: '2026-10-30T00:00:00Z',
  result,
  error: null,
})
beforeEach(() => sessionStorage.clear())
it('a cancelled write retains its original operation instead of treating read recovery as rejection', async () => {
  const call = vi.fn(async () => {
    throw new ResourceClientError('OFFICE_CANCELLED', 'retry_read')
  })
  const client = new ExpertClient(new ResourceController({ call }, () => scope))
  await expect(
    client.mutate('assistant/deleteDraft', { id: 'owned' }, new AbortController().signal)
  ).rejects.toMatchObject({ recovery: 'reconcile_original' })
  expect(client.pending()).toBeTruthy()
  expect(call).toHaveBeenCalledTimes(1)
})

it.each(['retry_read', 'repair_configuration', 'none'] as const)(
  'an unknown envelope retains the original write despite %s advice',
  async recovery => {
    const call = vi.fn(async (_method: string, request: IntegrationRequest) => ({
      ...reply(request, {}),
      status: 'unknown',
      result: null,
      error: { code: 'OFFICE_TIMEOUT', recovery, messageKey: 'office.reconcileOriginal' },
    }))
    const client = new ExpertClient(new ResourceController({ call }, () => scope))
    await expect(
      client.mutate('assistant/deleteDraft', { id: 'owned' }, new AbortController().signal)
    ).rejects.toMatchObject({ recovery: 'reconcile_original' })
    expect(client.pending()).toBeTruthy()
    expect(call).toHaveBeenCalledTimes(1)
  }
)
it('an explicitly rejected envelope does not manufacture an unknown write', async () => {
  const call = vi.fn(async (_method: string, request: IntegrationRequest) => ({
    ...reply(request, {}),
    status: 'rejected',
    result: null,
    error: {
      code: 'OFFICE_REVISION_CHANGED',
      recovery: 'retry_read',
      messageKey: 'office.operationFailed',
    },
  }))
  const client = new ExpertClient(new ResourceController({ call }, () => scope))
  await expect(
    client.mutate('assistant/deleteDraft', { id: 'owned' }, new AbortController().signal)
  ).rejects.toMatchObject({ recovery: 'retry_read' })
  expect(client.pending()).toBeNull()
})

it('a pre-cancelled write is not dispatched and does not leave an unresolved operation', async () => {
  const call = vi.fn()
  const client = new ExpertClient(new ResourceController({ call }, () => scope))
  const abort = new AbortController()
  abort.abort()
  await expect(
    client.mutate('assistant/deleteDraft', { id: 'owned' }, abort.signal)
  ).rejects.toMatchObject({ recovery: 'none' })
  expect(call).not.toHaveBeenCalled()
  expect(client.pending()).toBeNull()
})

it('an ignored late abort cannot turn a committed write into permission to resubmit', async () => {
  const abort = new AbortController()
  const call = vi.fn(async (_method: string, request: IntegrationRequest) => {
    abort.abort()
    return reply(request, { saved: true })
  })
  const client = new ExpertClient(new ResourceController({ call }, () => scope))
  await expect(
    client.mutate('assistant/deleteDraft', { id: 'owned' }, abort.signal)
  ).rejects.toMatchObject({ code: 'OFFICE_CANCELLED', recovery: 'reconcile_original' })
  expect(client.pending()).toBeTruthy()
  expect(call).toHaveBeenCalledTimes(1)
})

it('a late reconciliation cannot clear a different original operation', async () => {
  let settle!: (value: ReturnType<typeof reply>) => void
  let request!: IntegrationRequest
  const call = vi.fn(async (_method: string, value: IntegrationRequest) => {
    request = value
    return await new Promise<ReturnType<typeof reply>>(resolve => {
      settle = resolve
    })
  })
  const client = new ExpertClient(new ResourceController({ call }, () => scope))
  sessionStorage.setItem(client.pendingKey, 'old-operation')
  const reading = client.reconcile(new AbortController().signal)
  sessionStorage.setItem(client.pendingKey, 'new-operation')
  settle(reply(request, { operationId: 'old-operation', phase: 'completed' }))
  await reading
  expect(client.pending()).toBe('new-operation')
})
it('retains only the original operation after a lost install reply and never retries it', async () => {
  let reconciled = false
  const call = vi.fn(async (method: string, request: IntegrationRequest) => {
    if (method === 'agentDefinitions/operation/read') {
      reconciled = true
      return reply(request, { operationId: request.payload.operationId, phase: 'completed' })
    }
    throw new Error('private backend detail')
  })
  const client = new ExpertClient(new ResourceController({ call }, () => scope))
  const signal = new AbortController().signal
  await expect(
    client.mutate(
      'assistant/market/install',
      { id: 'personal.owned', slug: 'example', language: 'en' },
      signal
    )
  ).rejects.toMatchObject({ recovery: 'reconcile_original' })
  const original = client.pending()
  expect(original).toBeTruthy()
  expect(sessionStorage.getItem(client.pendingKey)).not.toContain('example')
  await expect(
    client.mutate('assistant/deleteDraft', { id: 'personal.owned' }, signal)
  ).rejects.toThrow('OFFICE_OUTCOME_UNKNOWN')
  expect(call).toHaveBeenCalledTimes(1)
  await client.reconcile(signal)
  expect(reconciled).toBe(true)
  expect(client.pending()).toBeNull()
})
it('keeps pending operations separated by profile target and requests personal inventory', async () => {
  const call = vi.fn(async (_method: string, request: IntegrationRequest) =>
    reply(request, { items: [], total: 0, nextCursor: null })
  )
  const client = new ExpertClient(new ResourceController({ call }, () => scope))
  const other = new ExpertClient(
    new ResourceController({ call }, () => ({ ...scope, targetId: 'two' }))
  )
  sessionStorage.setItem(client.pendingKey, 'original')
  expect(other.pending()).toBeNull()
  await client.list(undefined, 'en', new AbortController().signal)
  expect(call.mock.calls[0][1].payload.personalOnly).toBe(true)
  expect(newExpert('en').allowedTools).toBeNull()
  expect(newExpert('en').externalSend).toBe('deny')
})

it('new Octop drafts inherit tools without changing a pinned template or an explicit personal restriction', () => {
  const template = { ...newExpert('en'), id: 'builtin.octop.assistant', allowedTools: [] }
  const draft = newExpertFromTemplate(template)
  expect(draft.id).toMatch(/^personal\./)
  expect(draft.allowedTools).toBeNull()
  expect(template.allowedTools).toEqual([])
  expect(newExpertFromTemplate({ ...template, id: 'personal.restricted' }).allowedTools).toEqual([])
  expect(newExpertFromTemplate({ ...template, allowedTools: ['read'] }).allowedTools).toEqual([
    'read',
  ])
})

it('keeps an unconfirmed receipt pending when the target cannot reconcile it without replay', async () => {
  const call = vi.fn(async (method: string, request: IntegrationRequest) => {
    if (method === 'agentDefinitions/operation/read')
      return {
        ...reply(request, {}),
        status: 'rejected',
        result: null,
        error: {
          code: 'OFFICE_RECONCILIATION_REQUIRED',
          recovery: 'retry_read',
          messageKey: 'office.operationFailed',
        },
      }
    throw new Error('lost reply')
  })
  const client = new ExpertClient(new ResourceController({ call }, () => scope))
  const signal = new AbortController().signal
  await expect(
    client.mutate('assistant/market/install', { id: 'personal.owned' }, signal)
  ).rejects.toThrow()
  const original = client.pending()
  await expect(client.reconcile(signal)).rejects.toMatchObject({
    code: 'OFFICE_RECONCILIATION_REQUIRED',
  })
  expect(client.pending()).toBe(original)
  expect(call.mock.calls.map(([method]) => method)).toEqual([
    'integrations/assistant/market/install',
    'agentDefinitions/operation/read',
  ])
})

it('acknowledges only the explicitly reviewed pending identity without issuing a mutation', () => {
  const call = vi.fn()
  const client = new ExpertClient(new ResourceController({ call }, () => scope))
  sessionStorage.setItem(client.pendingKey, 'replacement')
  expect(client.acknowledgePending('old')).toBe(false)
  expect(client.pending()).toBe('replacement')
  expect(client.acknowledgePending('replacement')).toBe(true)
  expect(client.pending()).toBeNull()
  expect(call).not.toHaveBeenCalled()
})
