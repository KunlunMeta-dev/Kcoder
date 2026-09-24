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
