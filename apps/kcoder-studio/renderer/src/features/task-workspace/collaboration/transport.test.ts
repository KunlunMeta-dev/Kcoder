import { afterEach, beforeEach, expect, test } from 'vitest'
import { clearTestTransports, installTestTransport } from '@/test/runtime-transport'
import { createCollaborationAuthoringTransport } from '@/kcoder/collaborationAuthoringTransport'
import { notifyAccountContextChange } from '@/kcoder/accountContextEvents'
import { buildCollaborationPlan } from './buildPlan'
import {
  catalog,
  definition,
  installCollaborationGateway,
  prepared,
} from './gatewayFixture.test-support'

const owned: { dispose(): void | Promise<void> }[] = []
const target = { serverId: 'local', workspacePath: '/owned-workspace' }
beforeEach(() => {
  localStorage.clear()
  installTestTransport(() => undefined)
})
afterEach(async () => {
  for (const item of owned.splice(0).reverse()) await item.dispose()
  clearTestTransports()
})
function transport() {
  const value = createCollaborationAuthoringTransport(target, () => true)
  owned.push(value)
  return value
}

test('real LocalExecutor/Gateway sends finite native catalog/create/CAS/save without model execution', async () => {
  const gateway = installCollaborationGateway()
  owned.push(gateway)
  const api = transport()
  const observed = await api.catalog('original-thread')
  expect(observed.modelOrigin).toBe('thread_unobserved')
  expect(observed.modelSnapshot).toBeNull()
  const original = await api.create('Owned collaboration')
  const plan = buildCollaborationPlan(
    {
      scheme: 'research_review',
      objective: 'Compare fixed sources',
      criteria: 'Cite evidence',
      path: '',
    },
    observed
  )
  const applied = await api.apply(original, plan)
  const saved = await api.save(applied)
  expect(saved.savedVersion).toBe(1)
  expect(gateway.calls.map(call => call.method)).toEqual([
    'workflow/collaboration/catalog',
    'workflow/create',
    'workflow/collaboration/apply',
    'workflow/save',
  ])
  expect(gateway.calls[2].params).toEqual({ id: original.id, expectedRevision: 1, plan })
  expect(gateway.calls[3].params).toEqual({ id: original.id, expectedRevision: 2 })
  expect(
    gateway.client.requests.some(call =>
      ['thread/start', 'thread/resume', 'turn/start'].includes(call.method)
    )
  ).toBe(false)
})

test('native capability denial cannot issue a collaboration request', async () => {
  const gateway = installCollaborationGateway()
  gateway.supports.mockImplementation(capability => capability !== 'workflowCollaborationV1')
  owned.push(gateway)
  await expect(transport().catalog()).rejects.toMatchObject({ code: 'unavailable' })
  expect(gateway.calls).toHaveLength(0)
})

test('unknown create outcome is never retried or replaced by latest lookup', async () => {
  const gateway = installCollaborationGateway(async () => {
    throw new Error('Lost acknowledgement')
  })
  owned.push(gateway)
  await expect(transport().create('Owned collaboration')).rejects.toMatchObject({ code: 'unknown' })
  expect(gateway.calls.map(call => call.method)).toEqual(['workflow/create'])
})

test('read cancellation and target/account invalidation discard late frames', async () => {
  let release!: (value: unknown) => void
  const gateway = installCollaborationGateway(
    async () =>
      new Promise(done => {
        release = done
      })
  )
  owned.push(gateway)
  const api = transport(),
    cancel = new AbortController()
  const pending = api.catalog('original-thread', cancel.signal)
  await new Promise<void>(resolve => setTimeout(resolve, 10))
  cancel.abort()
  await expect(pending).rejects.toMatchObject({ code: 'cancelled' })
  release(catalog('original-thread'))
  notifyAccountContextChange('local')
  await expect(api.catalog()).rejects.toMatchObject({ code: 'scope_changed' })
  expect(gateway.calls).toHaveLength(1)
})

test('original draft identity/revision and model-origin mismatch fail closed', async () => {
  const gateway = installCollaborationGateway(async method => {
    if (method === 'workflow/collaboration/catalog')
      return { ...catalog(), modelOrigin: 'thread_snapshot' }
    if (method === 'workflow/collaboration/apply') return prepared()
    return definition({ id: 'different-native-draft' })
  })
  owned.push(gateway)
  const api = transport()
  await expect(api.catalog()).rejects.toMatchObject({ code: 'invalid_reply' })
  await expect(api.read('original-created-draft')).rejects.toMatchObject({ code: 'invalid_reply' })
  await expect(
    api.apply(
      prepared(),
      buildCollaborationPlan(
        { scheme: 'research_review', objective: 'Objective', criteria: 'Evidence', path: '' },
        catalog()
      )
    )
  ).rejects.toMatchObject({ code: 'invalid_reply' })
})

test('writing scheme contains original structured artifact requirements and explicit role dependencies', () => {
  const plan = buildCollaborationPlan(
    {
      scheme: 'draft_verify',
      objective: 'Write verified report',
      criteria: 'Cite sources\nCheck file',
      path: 'reports/result.md',
    },
    catalog()
  )
  const writer = plan.members.find(member => member.role === 'writer')!
  expect(writer.allowedWritePaths).toEqual(['reports/result.md'])
  expect(writer.artifactRequirements).toEqual([
    {
      path: 'reports/result.md',
      minBytes: 1,
      required: true,
      requireChanged: true,
      uniqueContent: true,
      forbiddenLiterals: [],
    },
  ])
  expect(plan.members.map(member => member.modelSelection)).toEqual(
    plan.members.map(() => ({ mode: 'inherit_current' }))
  )
  expect(plan.members.find(member => member.role === 'verifier')?.dependsOn).toEqual(['review'])
  for (const path of ['../escape', '/absolute', 'C:/other', '*.md', 'dir/../escape', 'dir\\file'])
    expect(() =>
      buildCollaborationPlan(
        { scheme: 'draft_verify', objective: 'Goal', criteria: 'Evidence', path },
        catalog()
      )
    ).toThrow('path')
})
