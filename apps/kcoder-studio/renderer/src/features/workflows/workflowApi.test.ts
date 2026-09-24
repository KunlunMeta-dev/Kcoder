import { beforeEach, expect, test, vi } from 'vitest'
vi.mock('@/tauri/localExecutor', () => ({
  requestLocalExecutor: vi.fn(async () => ({ accepted: true, taskId: 'task' })),
}))
import { requestLocalExecutor } from '@/tauri/localExecutor'
import {
  launchWorkflowConversation,
  newerDefinition,
  workflowApi,
  type WorkflowDefinition,
} from './workflowApi'
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
test('generation uses a restricted real conversation; reuse pins the published version and workspace', async () => {
  await launchWorkflowConversation({
    serverId: 'remote',
    workspacePath: '/chosen',
    definition: draft,
    generate: true,
    request: 'Prepare a plan',
  })
  expect(call).toHaveBeenLastCalledWith(
    'runtime.tasks.create',
    expect.objectContaining({
      deviceId: 'remote',
      workspacePath: '/chosen',
      sessionMode: 'workflow_draft',
      executionRequest: { prompt: expect.stringContaining('build draft "owned"') },
    })
  )
  await launchWorkflowConversation({
    serverId: 'remote',
    workspacePath: '/other-project',
    definition: draft,
    generate: false,
  })
  expect(call).toHaveBeenLastCalledWith(
    'runtime.tasks.create',
    expect.objectContaining({
      workspacePath: '/other-project',
      sessionMode: 'default',
      executionRequest: { prompt: expect.stringContaining('"definition_id":"owned","version":1') },
    })
  )
  await expect(
    launchWorkflowConversation({
      serverId: 'remote',
      workspacePath: '/chosen',
      definition: { ...draft, savedVersion: null },
      generate: false,
    })
  ).rejects.toThrow()
})
