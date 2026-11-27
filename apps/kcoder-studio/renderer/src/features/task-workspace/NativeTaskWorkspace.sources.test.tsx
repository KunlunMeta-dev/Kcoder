import { StrictMode, useEffect } from 'react'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, expect, test, vi } from 'vitest'
import type { IntegrationTaskCapabilityScopeControlTarget } from '../../../../shared/generated/contracts'
const fixture = vi.hoisted(() => ({ read: vi.fn(), current: () => true, disposals: vi.fn() }))
vi.mock('@/host/localExecutor', async importOriginal => ({
  ...await importOriginal<typeof import('@/host/localExecutor')>(),
  subscribeLocalExecutorEvents: vi.fn().mockResolvedValue(() => {}),
}))
vi.mock('@/hooks/useTranslation', () => ({
  useTranslation: () => ({ t: (key: string) => key, i18n: { language: 'en' } }),
}))
vi.mock('@/kcoder/usePluginTargetScope', () => ({
  usePluginTargetScope: () => ({ key: 'owned-current-target', isCurrent: fixture.current }),
}))
vi.mock('@/kcoder/taskWorkspaceTransport', () => ({
  TaskWorkspaceClientError: class extends Error {
    readonly code: string
    constructor(code: string) {
      super(code)
      this.code = code
    }
  },
  createTaskWorkspaceTransport: () => ({
    read: fixture.read,
    isCurrent: () => true,
    dispose: fixture.disposals,
  }),
}))
import { NativeTaskWorkspace } from './NativeTaskWorkspace'
const original: IntegrationTaskCapabilityScopeControlTarget = {
  initialAttempt: {
    threadId: 'original-thread',
    turnId: 'original-turn',
    attemptId: 'original-attempt',
  },
  runtimeOperationId: 'original-runtime',
}
function snapshot(params: Record<string, unknown>) {
  return {
    schemaVersion: 1,
    scope: {
      accountId: 'owner',
      targetId: 'native',
      workspaceId: null,
      identityGeneration: '1',
      targetRevision: '1',
    },
    snapshotId: 'fixed-observation',
    observedAtMs: 1,
    thread: {
      reference: { kind: 'thread', threadId: 'original-thread' },
      title: 'Original task',
      nativeStatus: 'idle',
      sourceMethod: 'thread/read',
      nativeRevision: null,
    },
    entries: [],
    facets: [],
    artifactRefs: [],
    runtime: null,
    sourceSelection: null,
    nextCursor: null,
    ...(params.sourceTarget ? { sourceTarget: params.sourceTarget } : {}),
  }
}
function Selector({
  choose,
}: {
  choose: (target: IntegrationTaskCapabilityScopeControlTarget | undefined) => void
}) {
  useEffect(() => () => choose(undefined), [choose])
  return (
    <button data-testid="explicit-source-choice" onClick={() => choose(original)}>
      Select original binding
    </button>
  )
}
afterEach(() => {
  cleanup()
  fixture.read.mockReset()
  fixture.disposals.mockReset()
})
function view() {
  return (
    <StrictMode>
      <NativeTaskWorkspace
        target={{ serverId: 'native', workspacePath: '/owned' }}
        tasks={[{ threadId: 'original-thread', title: 'Original task', workspacePath: '/owned' }]}
        renderSourceRecords={(_target, _thread, choose) => <Selector choose={choose} />}
      />
    </StrictMode>
  )
}
function chooseThread() {
  fireEvent.change(screen.getByTestId('task-workspace-thread-select'), {
    target: { value: JSON.stringify(['original-thread', '/owned']) },
  })
}
test('only explicit binding selection enriches reads and keeps the source selector mounted through the new owner', async () => {
  fixture.read.mockImplementation(async params => snapshot(params))
  render(view())
  chooseThread()
  await screen.findByTestId('task-workspace-root-status')
  expect(fixture.read.mock.calls.every(([params]) => !Object.hasOwn(params, 'sourceTarget'))).toBe(
    true
  )
  fireEvent.click(screen.getByTestId('explicit-source-choice'))
  await waitFor(() =>
    expect(
      fixture.read.mock.calls.some(
        ([params]) => JSON.stringify(params.sourceTarget) === JSON.stringify(original)
      )
    ).toBe(true)
  )
  await screen.findByTestId('task-workspace-root-status')
  expect(screen.getByTestId('explicit-source-choice')).toBeInTheDocument()
  expect(fixture.read.mock.calls.at(-1)![0].sourceTarget).toEqual(original)
})
test('a late old tuple observation cannot replace the explicit source-target request', async () => {
  let settle!: (value: unknown) => void
  fixture.read.mockImplementation(params =>
    params.sourceTarget
      ? Promise.resolve(snapshot(params))
      : new Promise(resolve => {
          settle = resolve
        })
  )
  render(view())
  chooseThread()
  await waitFor(() => expect(settle).toBeTypeOf('function'))
  fireEvent.click(screen.getByTestId('explicit-source-choice'))
  await screen.findByTestId('task-workspace-root-status')
  await act(async () =>
    settle({
      ...snapshot({}),
      thread: { ...snapshot({}).thread, title: 'Old unselected delayed task' },
    })
  )
  expect(screen.queryByText('Old unselected delayed task')).not.toBeInTheDocument()
  expect(fixture.read.mock.calls.at(-1)![0].sourceTarget).toEqual(original)
})
