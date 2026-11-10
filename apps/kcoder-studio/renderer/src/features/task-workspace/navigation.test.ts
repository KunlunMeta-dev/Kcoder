import { expect, test } from 'vitest'
import type { RuntimeDeviceWorkspace } from '@/types/api'
import { nativeThreadAddress } from './navigation'

const reference = { kind: 'thread', threadId: 'original-thread' } as const
const target = { serverId: 'owned-target', workspacePath: '/owned' }
function workspace(patch: Partial<RuntimeDeviceWorkspace> = {}): RuntimeDeviceWorkspace {
  return {
    deviceId: 'owned-target',
    available: true,
    workspacePath: '/owned',
    tasks: [
      {
        taskId: 'original-client-alias',
        threadId: 'original-thread',
        workspacePath: '/owned',
        title: 'Original task',
        runtime: 'kcoder',
        runtimeHandle: { session_id: 'original-thread', owner: 'original-owner' },
      },
    ],
    ...patch,
  }
}

test('uses the existing client alias and original handle without reconstructing either', () => {
  const source = workspace()
  const address = nativeThreadAddress([source], target, reference)
  expect(address).toEqual({
    deviceId: 'owned-target',
    taskId: 'original-client-alias',
    threadId: 'original-thread',
    workspacePath: '/owned',
    runtimeHandle: { session_id: 'original-thread', owner: 'original-owner' },
  })
  expect(address?.runtimeHandle).not.toBe(source.tasks[0].runtimeHandle)
})

test('missing original thread mappings never fall back to a guessed task alias', () => {
  const source = workspace()
  source.tasks[0].threadId = null
  source.tasks[0].taskId = 'kcoder:owned-target:original-thread'
  expect(nativeThreadAddress([source], target, reference)).toBeUndefined()
})

test('the same thread on another target or workspace cannot satisfy navigation', () => {
  expect(nativeThreadAddress([workspace({ deviceId: 'peer' })], target, reference)).toBeUndefined()
  expect(
    nativeThreadAddress([workspace()], { ...target, workspacePath: '/peer' }, reference)
  ).toBeUndefined()
})

test('worktree navigation uses the actual worktree root rather than a stale task path', () => {
  const source = workspace({ workspaceKind: 'worktree', workspacePath: '/owned/tree' })
  expect(
    nativeThreadAddress([source], { ...target, workspacePath: '/owned/tree' }, reference)
      ?.workspacePath
  ).toBe('/owned/tree')
  expect(nativeThreadAddress([source], target, reference)).toBeUndefined()
})

test('duplicate projections are harmless but distinct original addresses remain ambiguous', () => {
  const source = workspace()
  expect(nativeThreadAddress([source, structuredClone(source)], target, reference)?.taskId).toBe(
    'original-client-alias'
  )
  const peer = workspace()
  peer.tasks[0].taskId = 'another-original-alias'
  expect(nativeThreadAddress([source, peer], target, reference)).toBeUndefined()
  const replaced = workspace()
  replaced.tasks[0].runtimeHandle = { session_id: 'original-thread', owner: 'replacement-owner' }
  expect(nativeThreadAddress([source, replaced], target, reference)).toBeUndefined()
})

test('goal and workflow identities are never substituted with their parent conversation', () => {
  expect(
    nativeThreadAddress([workspace()], target, {
      kind: 'goal',
      threadId: 'original-thread',
      goalId: 'goal',
      revision: 1,
    })
  ).toBeUndefined()
  expect(
    nativeThreadAddress([workspace()], target, {
      kind: 'workflow_run',
      threadId: 'original-thread',
      runId: 'workflow-run',
    })
  ).toBeUndefined()
})
