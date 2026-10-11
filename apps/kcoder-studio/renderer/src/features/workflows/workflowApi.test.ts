import { beforeEach, expect, test, vi } from 'vitest'
vi.mock('@/tauri/localExecutor', () => ({
  requestLocalExecutor: vi.fn(async () => ({ accepted: true, taskId: 'task' })),
}))
import { requestLocalExecutor } from '@/tauri/localExecutor'
import { newerDefinition, workflowApi, type WorkflowDefinition } from './workflowApi'
const call = vi.mocked(requestLocalExecutor)
const draft: WorkflowDefinition = {
  id: 'owned',
  title: 'A flow',
  description: '',
  revision: 4,
  status: 'draft',
  nodes: [],
  createdAtMs: 1,
  updatedAtMs: 2,
  savedVersion: 1,
}
beforeEach(() => call.mockClear())
test('late read cannot roll back a newer revision', () => {
  expect(newerDefinition(draft, { ...draft, revision: 3 })).toBe(draft)
  expect(newerDefinition(draft, { ...draft, revision: 5 }).revision).toBe(5)
})
test('edits and publishing require explicit revision; reads are target-scoped and paginated', async () => {
  await workflowApi.list('remote', 32)
  expect(call).toHaveBeenLastCalledWith('runtime.workflows.request', {
    serverId: 'remote',
    method: 'workflow/list',
    params: { offset: 32, limit: 32 },
  })
  await workflowApi.save('remote', 'owned', 4)
  expect(call).toHaveBeenLastCalledWith('runtime.workflows.request', {
    serverId: 'remote',
    method: 'workflow/save',
    params: { id: 'owned', expectedRevision: 4 },
  })
  expect(call.mock.calls.every(([method]) => method !== 'runtime.tasks.create')).toBe(true)
})
test('historical viewing and cloning pin an explicit version without executing a conversation', async () => {
  await workflowApi.exportDefinition('remote', 'owned', 1)
  expect(call).toHaveBeenLastCalledWith('runtime.workflows.request', {
    serverId: 'remote',
    method: 'workflow/export',
    params: { id: 'owned', version: 1 },
  })
  await workflowApi.clone('remote', 'owned', 1)
  expect(call).toHaveBeenLastCalledWith('runtime.workflows.request', {
    serverId: 'remote',
    method: 'workflow/clone',
    params: { id: 'owned', version: 1 },
  })
  await workflowApi.importDefinition('remote', draft)
  expect(call).toHaveBeenLastCalledWith('runtime.workflows.request', {
    serverId: 'remote',
    method: 'workflow/import',
    params: { definition: draft },
  })
  expect(call.mock.calls.every(([method]) => method !== 'runtime.tasks.create')).toBe(true)
})

test('layout refreshes at the same content revision without accepting older positions', () => {
  const moved = { ...draft, updatedAtMs: 10 }
  expect(newerDefinition(draft, moved)).toBe(moved)
  expect(newerDefinition(moved, draft)).toBe(moved)
})
test('moving a node sends only position CAS, not stale content or a content revision', async () => {
  await workflowApi.move(
    'remote',
    'owned',
    {
      id: 'a',
      position: { x: 100, y: 200 },
      prompt: 'stale',
    } as import('./workflowApi').WorkflowNode,
    { x: 0, y: 0 }
  )
  expect(call).toHaveBeenLastCalledWith('runtime.workflows.request', {
    serverId: 'remote',
    method: 'workflow/moveNode',
    params: {
      id: 'owned',
      nodeId: 'a',
      expectedPosition: { x: 0, y: 0 },
      position: { x: 100, y: 200 },
    },
  })
})

test('conditional definition reads preserve position revision and unchanged snapshot identity', async () => {
  call.mockResolvedValueOnce({
    unchanged: true,
    id: draft.id,
    revision: draft.revision,
    updatedAtMs: draft.updatedAtMs,
  })
  expect(await workflowApi.read('remote', draft.id, draft)).toBe(draft)
  expect(call).toHaveBeenLastCalledWith('runtime.workflows.request', {
    serverId: 'remote',
    method: 'workflow/read',
    params: { id: draft.id, knownRevision: draft.revision, knownUpdatedAtMs: draft.updatedAtMs },
  })
  call.mockResolvedValueOnce({
    unchanged: true,
    id: 'someone-else',
    revision: draft.revision,
    updatedAtMs: draft.updatedAtMs,
  })
  await expect(workflowApi.read('remote', draft.id, draft)).rejects.toThrow('did not match')
})

test('conditional run reads reject unknown unchanged identities while full legacy reads remain compatible', async () => {
  const run = {
    runId: 'run',
    revision: 3,
    status: 'completed',
  } as import('./workflowApi').WorkflowRun
  call.mockResolvedValueOnce({ unchanged: true, runId: run.runId, revision: run.revision })
  expect(await workflowApi.run('remote', run.runId, run)).toBe(run)
  call.mockResolvedValueOnce({ unchanged: true, runId: run.runId, revision: 4 })
  await expect(workflowApi.run('remote', run.runId, run)).rejects.toThrow('did not match')
  call.mockResolvedValueOnce(run)
  expect(await workflowApi.run('remote', run.runId)).toBe(run)
  expect(call).toHaveBeenLastCalledWith('runtime.workflows.request', {
    serverId: 'remote',
    method: 'workflow/runs/read',
    params: { runId: run.runId },
  })
})

test('version evidence stays scoped and explicit archival sends confirmation and semantic CAS', async () => {
  call.mockResolvedValueOnce({
    definitionId: 'owned',
    savedVersion: 2,
    draftStatus: 'saved',
    availability: 'saved',
    runs: [],
    totalRunCount: 0,
    nextOffset: null,
  })
  await workflowApi.verification('remote', 'owned', 2, 32, 16)
  expect(call).toHaveBeenLastCalledWith('runtime.workflows.request', {
    serverId: 'remote',
    method: 'workflow/verification/read',
    params: { id: 'owned', version: 2, offset: 32, limit: 16 },
  })
  call.mockResolvedValueOnce({ definitionId: 'other', savedVersion: 2, runs: [] })
  await expect(workflowApi.verification('remote', 'owned', 2)).rejects.toThrow('did not match')
  await workflowApi.archiveVersion('remote', 'owned', 1, 7)
  expect(call).toHaveBeenLastCalledWith('runtime.workflows.request', {
    serverId: 'remote',
    method: 'workflow/versions/archive',
    params: { id: 'owned', version: 1, expectedRevision: 7, confirm: true },
  })
})

test('read signal reaches every pending-request page without altering scope or mutation contracts', async () => {
  const controller = new AbortController()
  const options = { signal: controller.signal }
  call.mockResolvedValueOnce(draft)
  await workflowApi.read('remote', 'owned', draft, options)
  expect(call).toHaveBeenLastCalledWith(
    'runtime.workflows.request',
    expect.objectContaining({ serverId: 'remote', method: 'workflow/read' }),
    options
  )
  call.mockResolvedValueOnce({ supported: true, requests: [], nextAfter: 'cursor' })
  call.mockResolvedValueOnce({ supported: true, requests: [] })
  await workflowApi.requests('remote', 'run', options)
  expect(call).toHaveBeenLastCalledWith(
    'runtime.workflows.request',
    {
      serverId: 'remote',
      method: 'workflow/runs/requests',
      params: { runId: 'run', after: 'cursor' },
    },
    options
  )
  await workflowApi.save('remote', 'owned', 4)
  expect(call.mock.calls.at(-1)).toHaveLength(2)
})

test('run archive preserves exact IDs/token/confirmation and archived reads are cancellable', async () => {
  const ids = ['run-b', 'run-a'],
    signal = new AbortController().signal
  await workflowApi.archivePreview('remote', ids, { signal })
  expect(call).toHaveBeenLastCalledWith(
    'runtime.workflows.request',
    { serverId: 'remote', method: 'workflow/runs/archive/preview', params: { runIds: ids } },
    { signal }
  )
  await workflowApi.archiveRuns('remote', ids, 'preview-token', true)
  expect(call).toHaveBeenLastCalledWith('runtime.workflows.request', {
    serverId: 'remote',
    method: 'workflow/runs/archive',
    params: { runIds: ids, previewToken: 'preview-token', confirm: true },
  })
  await workflowApi.archivedRuns('remote', 20, { signal })
  expect(call).toHaveBeenLastCalledWith(
    'runtime.workflows.request',
    { serverId: 'remote', method: 'workflow/runs/archive/list', params: { offset: 20, limit: 20 } },
    { signal }
  )
})
