import { beforeEach, expect, test, vi } from 'vitest'
import { requestLocalExecutor } from '@/tauri/localExecutor'
import { knowledgeApi, type WikiImageImport } from './knowledgeApi'

vi.mock('@/tauri/localExecutor', () => ({ requestLocalExecutor: vi.fn() }))
const item: WikiImageImport = {
  id: 'durable-import',
  idempotencyKey: 'file:exact-digest',
  title: 'one.png',
  status: 'failed',
  phase: 'commit',
  model: 'vision',
  sourceId: null,
  revisionId: null,
  errorCode: 'source_commit_failed',
  reservedCalls: 1,
  callLimit: 1,
  usageReportedCalls: 1,
  unknownUsageCalls: 0,
  inputTokens: 12,
  outputTokens: 7,
  textBytes: 100,
  reasoningBytes: 0,
  updatedAtMs: 1,
}
const source = {
  sourceId: 'same-source',
  revisionId: 'revision',
  title: 'one.png',
  bodyHash: 'hash',
}
// RPC identity/call authorization fixture only; native tests upload decoded PNG bytes to the real target.
beforeEach(() => {
  vi.mocked(requestLocalExecutor)
    .mockReset()
    .mockImplementation(async (_method, input) => {
      const request = input as { method: string }
      if (request.method === 'knowledge/fileCapabilities') return { supported: false, items: [] }
      if (request.method === 'attachment/upload/start') return { upload_id: 'new-upload' }
      if (request.method === 'attachment/upload/finish') return { path: '/owned/new-upload' }
      if (request.method === 'knowledge/attachment/digest') return { key: 'exact-digest' }
      if (request.method === 'knowledge/imageImport/list')
        return { supported: true, items: [item], nextAfterId: null }
      if (
        ['knowledge/imageImport/resume', 'knowledge/source/importAttachment'].includes(
          request.method
        )
      )
        return source
      return {}
    })
})
test('batch reupload keeps exact digest identity and explicitly resumes only the failed commit without another call budget', async () => {
  expect(
    await knowledgeApi.importFile('target', 'library', new File([], 'one.png'), () => true, true)
  ).toEqual(source)
  expect(requestLocalExecutor).toHaveBeenCalledWith('runtime.knowledge.request', {
    serverId: 'target',
    method: 'knowledge/imageImport/resume',
    params: { libraryId: 'library', importId: item.id, additionalCallBudget: 0 },
  })
  expect(
    vi
      .mocked(requestLocalExecutor)
      .mock.calls.some(
        ([, input]) => (input as { method: string }).method === 'knowledge/source/importAttachment'
      )
  ).toBe(false)
})
test('incomplete interpretation retry authorizes one new call and initial uploads keep the same target digest key', async () => {
  await knowledgeApi.importFile('target', 'library', new File([], 'one.png'), () => true)
  expect(requestLocalExecutor).toHaveBeenCalledWith('runtime.knowledge.request', {
    serverId: 'target',
    method: 'knowledge/source/importAttachment',
    params: {
      libraryId: 'library',
      idempotencyKey: item.idempotencyKey,
      title: 'one.png',
      attachmentPath: '/owned/new-upload',
    },
  })
  await knowledgeApi.resumeImageImport('target', 'library', { ...item, phase: 'interpretation' })
  expect(requestLocalExecutor).toHaveBeenLastCalledWith('runtime.knowledge.request', {
    serverId: 'target',
    method: 'knowledge/imageImport/resume',
    params: { libraryId: 'library', importId: item.id, additionalCallBudget: 1 },
  })
})

test('replacement identity pins its expected source revision while remaining stable on the same retry', async () => {
  const file = new File([], 'one.png')
  for (const revisionId of ['revision-one', 'revision-one', 'revision-two']) {
    await knowledgeApi.updateSourceFile(
      'target',
      'library',
      { ...source, revisionId },
      file,
      () => true
    )
  }
  const imports = vi
    .mocked(requestLocalExecutor)
    .mock.calls.map(
      ([, input]) =>
        input as { method: string; params: { idempotencyKey: string; expectedRevision: string } }
    )
    .filter(input => input.method === 'knowledge/source/importAttachment')
  expect(imports.map(input => input.params.idempotencyKey)).toEqual([
    'update:revision-one:exact-digest',
    'update:revision-one:exact-digest',
    'update:revision-two:exact-digest',
  ])
  expect(imports.map(input => input.params.expectedRevision)).toEqual([
    'revision-one',
    'revision-one',
    'revision-two',
  ])
})
