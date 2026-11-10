import { expect, test, vi } from 'vitest'
import { fixedTaskArtifacts, nativeTaskArtifactPhase } from './fixedArtifacts'
import { OfficeController } from '@/features/office-integration/controller'
import type {
  IntegrationRequest,
  IntegrationScope,
  OfficeArtifactManifest,
} from '../../../../../shared/generated/contracts'
const scope: IntegrationScope = {
  accountId: 'owned',
  targetId: 'target',
  workspaceId: 'workspace',
  identityGeneration: '1',
  targetRevision: '1',
}
function manifest(id: string, revision: number): OfficeArtifactManifest {
  return {
    schemaVersion: 1,
    id,
    revision,
    owner: { accountId: 'owned', targetId: 'target', workspaceId: 'workspace' },
    task: { threadId: 'original-thread', turnId: 'original-turn' },
    kind: 'document',
    title: id,
    format: 'docx',
    bytes: 8,
    sha256: 'a'.repeat(64),
    sourceRefs: [],
    verification: {
      status: 'pending',
      completedChecks: [],
      pendingChecks: ['reader'],
      readerStatus: 'pending',
      formulaCalculation: 'not_applicable',
    },
    createdAtMs: 1,
  }
}
function client(change?: (value: OfficeArtifactManifest) => OfficeArtifactManifest) {
  const call = vi.fn(async (_method: string, request: IntegrationRequest) => {
    const ref = (request.payload as { reference: { id: string; revision: number } }).reference
    const value = manifest(ref.id, ref.revision)
    return {
      contractVersion: 'parallel-v1',
      requestId: request.requestId,
      operationId: null,
      entityRevision: null,
      status: 'completed',
      observedAt: '2026-10-25T00:00:00Z',
      result: { manifest: change ? change(value) : value },
      error: null,
    }
  })
  return { call, controller: new OfficeController({ call }, () => scope) }
}
test('fixed original refs page ten at a time through native reads without latest list lookup', async () => {
  const f = client()
  const refs = Array.from({ length: 12 }, (_, i) => ({
    kind: 'artifact' as const,
    id: `artifact-${i}`,
    revision: '3',
  }))
  const read = fixedTaskArtifacts(f.controller, 'original-thread', refs, scope)
  const first = await read(undefined, new AbortController().signal)
  expect(first.items).toHaveLength(10)
  expect(first.nextCursor).toMatch(/:10$/)
  const next = await read(first.nextCursor!, new AbortController().signal)
  expect(next.items).toHaveLength(2)
  expect(next.nextCursor).toBeNull()
  expect(f.call.mock.calls.every(([method]) => method === 'integrations/artifact/read')).toBe(true)
  expect(
    f.call.mock.calls.every(
      ([, request]) =>
        (request.payload as { reference: { revision: number } }).reference.revision === 3
    )
  ).toBe(true)
  await expect(read('1', new AbortController().signal)).rejects.toMatchObject({
    code: 'OFFICE_CURSOR_EXPIRED',
  })
  await expect(
    fixedTaskArtifacts(
      f.controller,
      'original-thread',
      refs,
      scope
    )(first.nextCursor!, new AbortController().signal)
  ).rejects.toMatchObject({ code: 'OFFICE_CURSOR_EXPIRED' })
})
test('a different revision or parent thread cannot replace an original artifact selector', async () => {
  for (const change of [
    (m: OfficeArtifactManifest) => ({ ...m, revision: 4 }),
    (m: OfficeArtifactManifest) => ({ ...m, task: { ...m.task, threadId: 'peer-thread' } }),
    (m: OfficeArtifactManifest) => ({ ...m, owner: { ...m.owner, accountId: 'peer-account' } }),
  ]) {
    const f = client(change)
    await expect(
      fixedTaskArtifacts(
        f.controller,
        'original-thread',
        [{ kind: 'artifact', id: 'a', revision: '3' }],
        scope
      )(undefined, new AbortController().signal)
    ).rejects.toMatchObject({ code: 'OFFICE_REVISION_CONFLICT' })
  }
})
test('missing revision, unknown kind and aborted pages never silently become empty success', async () => {
  const f = client()
  for (const ref of [
    { kind: 'artifact', id: 'a', revision: null },
    { kind: 'dataset', id: 'a', revision: '3' },
  ] as const)
    expect(() => fixedTaskArtifacts(f.controller, 'original-thread', [ref], scope)).toThrow()
  const aborted = new AbortController()
  aborted.abort()
  await expect(
    fixedTaskArtifacts(
      f.controller,
      'original-thread',
      [{ kind: 'artifact', id: 'a', revision: '3' }],
      scope
    )(undefined, aborted.signal)
  ).rejects.toBeTruthy()
  expect(f.call).not.toHaveBeenCalled()
})

test('only the original native completed turn unfolds final previews; idle and unknown never imply success', () => {
  expect(nativeTaskArtifactPhase(undefined, false)).toBe('unknown')
  expect(nativeTaskArtifactPhase('idle', false)).toBe('unknown')
  expect(nativeTaskArtifactPhase('completed', false)).toBe('completed')
  expect(nativeTaskArtifactPhase('completed', true)).toBe('running')
  expect(nativeTaskArtifactPhase('failed', false)).toBe('failed')
  expect(nativeTaskArtifactPhase('interrupted', false)).toBe('cancelled')
  expect(nativeTaskArtifactPhase('inProgress', false)).toBe('running')
})

test('selected automation frozen refs bind the actual workflow child without changing ordinary exact-thread selection', async () => {
  const f = client(m => ({ ...m, task: { threadId: 'actual-child', turnId: 'actual-child-turn', runId: 'workflow-original' } }))
  const refs = [{ kind: 'artifact' as const, id: 'original-artifact', revision: '3' }]
  // Metadata selectors only. Native still verifies the original private child.
  const read = Reflect.apply(fixedTaskArtifacts, undefined, [f.controller, 'parent-thread', refs, scope,
    { runId: 'automation-original', workflowTaskId: 'workflow-original' }])
  expect((await read(undefined, new AbortController().signal)).items).toHaveLength(1)
  expect(f.call.mock.calls.every(([method]) => method === 'integrations/artifact/read')).toBe(true)
  await expect(fixedTaskArtifacts(f.controller, 'parent-thread', refs, scope)(undefined, new AbortController().signal))
    .rejects.toMatchObject({ code: 'OFFICE_REVISION_CONFLICT' })
})
test('automation metadata never substitutes a foreign workflow, owner, revision or ordinary parent task', async () => {
  const changes = [
    (m: OfficeArtifactManifest) => ({ ...m, task: { ...m.task, runId: 'workflow-foreign' } }),
    (m: OfficeArtifactManifest) => ({ ...m, task: { ...m.task, threadId: 'parent-thread' } }),
    (m: OfficeArtifactManifest) => ({ ...m, revision: 4 }),
    ...(['accountId', 'targetId', 'workspaceId'] as const).map(field =>
      (m: OfficeArtifactManifest) => ({ ...m, owner: { ...m.owner, [field]: 'foreign' } })),
  ]
  for (const change of changes) {
    const f = client(m => change({ ...m, task: { threadId: 'actual-child', turnId: 'actual-child-turn', runId: 'workflow-original' } }))
    const read = fixedTaskArtifacts(f.controller, 'parent-thread', [{ kind: 'artifact', id: 'original-artifact', revision: '3' }], scope,
      { runId: 'automation-original', workflowTaskId: 'workflow-original' })
    await expect(read(undefined, new AbortController().signal)).rejects.toMatchObject({ code: 'OFFICE_REVISION_CONFLICT' })
  }
})
