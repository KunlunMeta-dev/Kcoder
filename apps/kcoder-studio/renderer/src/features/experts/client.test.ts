import { beforeEach, expect, it, vi } from 'vitest'
import type { IntegrationRequest, IntegrationScope } from '../../../../shared/generated/contracts'
import { OfficeController } from '../office-integration/controller'
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
it('retains only the original operation after a lost install reply and never retries it', async () => {
  let reconciled = false
  const call = vi.fn(async (method: string, request: IntegrationRequest) => {
    if (method.endsWith('/readOperation')) {
      reconciled = true
      return reply(request, { operationId: request.payload.operationId, phase: 'completed' })
    }
    throw new Error('private backend detail')
  })
  const client = new ExpertClient(new OfficeController({ call }, () => scope))
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
it('keeps pending operations separated by Native target and requests personal inventory', async () => {
  const call = vi.fn(async (_method: string, request: IntegrationRequest) =>
    reply(request, { items: [], total: 0, nextCursor: null })
  )
  const client = new ExpertClient(new OfficeController({ call }, () => scope))
  const other = new ExpertClient(
    new OfficeController({ call }, () => ({ ...scope, targetId: 'two' }))
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
