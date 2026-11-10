import { StrictMode } from 'react'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { createInstance } from 'i18next'
import { I18nextProvider } from 'react-i18next'
import { clearTestTransports, installTestTransport } from '@/test/runtime-transport'
import { NativeTaskWorkspace, type NativeTaskWorkspaceProps } from './NativeTaskWorkspace'
import { taskWorkspaceResources } from './locales'
import {
  installTaskWorkspaceGateway,
  localServer,
  nativeScope,
  reply,
  snapshot,
  taskMethod,
} from './gatewayFixture.test-support'
import { notifyAccountContextChange } from '@/kcoder/accountContextEvents'

vi.mock('@/kcoder/gatewayRpc', async original => ({
  ...(await original<object>()),
  fetchGatewayServers: async () => [localServer],
}))
const owned: { dispose(): Promise<void> }[] = []
const target = { serverId: 'local', workspacePath: '/owned-workspace' }
const tasks = [
  { threadId: 'original-thread', title: 'Original task choice', workspacePath: '/owned-workspace' },
]
beforeEach(() => {
  localStorage.clear()
  installTestTransport(() => undefined)
})
afterEach(async () => {
  cleanup()
  await Promise.all(owned.splice(0).map(item => item.dispose()))
  vi.restoreAllMocks()
  clearTestTransports()
})
async function mount(props: Partial<NativeTaskWorkspaceProps> = {}, language = 'zh-CN') {
  const i18n = createInstance()
  await i18n.init({
    lng: language,
    fallbackLng: 'en',
    resources: {
      en: { taskWorkspace: taskWorkspaceResources.en },
      'zh-CN': { taskWorkspace: taskWorkspaceResources['zh-CN'] },
    },
    interpolation: { escapeValue: false },
  })
  const component = (next: Partial<NativeTaskWorkspaceProps> = {}) => (
    <StrictMode>
      <I18nextProvider i18n={i18n}>
        <NativeTaskWorkspace target={target} tasks={tasks} {...props} {...next} />
      </I18nextProvider>
    </StrictMode>
  )
  const rendered = render(component())
  return {
    ...rendered,
    change(next: Partial<NativeTaskWorkspaceProps>) {
      rendered.rerender(component(next))
    },
  }
}
function selectTask() {
  fireEvent.change(screen.getByTestId('task-workspace-thread-select'), {
    target: { value: JSON.stringify(['original-thread', '/owned-workspace']) },
  })
}

test('a business work row opens its original conversation without showing another task overview', async () => {
  const gateway = installTaskWorkspaceGateway()
  owned.push(gateway)
  const open = vi.fn()
  const work = {
    workId: 'work-1',
    threadId: 'original-thread',
    phase: 'pending',
    freshness: 'partial',
    revision: 1,
    requirementsRevision: 1,
  }
  const view = await mount({ canOpenReference: () => true, onOpenReference: open })
  selectTask()
  await waitFor(() =>
    expect(screen.getByTestId('task-workspace-root-status')).toHaveTextContent('notLoaded')
  )
  const previousReads = gateway.calls.filter(call => call.method === taskMethod).length
  view.change({
    tasks: [
      {
        threadId: 'original-thread',
        workId: 'work-1',
        title: 'Business work',
        workspacePath: '/owned-workspace',
        board: {
          targetLabel: 'Local',
          stale: false,
          work,
          task: {
            taskId: 'original',
            threadId: 'original-thread',
            workspacePath: '/owned-workspace',
            title: 'Original',
            runtime: 'kcoder',
            updatedAt: Date.now(),
          },
        },
      },
    ],
  })
  expect(await screen.findByText('请打开原会话查看最新进展。')).toBeInTheDocument()
  expect(gateway.calls.filter(call => call.method === taskMethod)).toHaveLength(previousReads)
  fireEvent.click(screen.getByRole('button', { name: '打开任务: Business work' }))
  expect(open).toHaveBeenCalledWith({ kind: 'thread', threadId: 'original-thread' }, target)
})

test('uses original task status and unknown counts without picking or starting a thread', async () => {
  const gateway = installTaskWorkspaceGateway()
  owned.push(gateway)
  const open = vi.fn()
  await mount({ onOpenReference: open })
  expect(gateway.calls).toHaveLength(0)
  selectTask()
  await waitFor(() =>
    expect(screen.getByTestId('task-workspace-root-status')).toHaveTextContent('notLoaded')
  )
  expect(screen.getByTestId('task-workspace-facet-agents')).toHaveTextContent('暂未确认')
  expect(screen.getByTestId('task-workspace-facet-agents')).not.toHaveTextContent('0')
  expect(screen.getByTestId('task-workspace-entry-status-0')).toHaveAttribute(
    'data-native-status',
    'running'
  )
  expect(screen.getByTestId('task-workspace-entry-status-1')).toHaveTextContent(
    'future_agent_state'
  )
  expect(screen.getByTestId('task-workspace-entry-status-2')).toHaveTextContent('succeeded')
  expect(within(screen.getByRole('table', { name: '关联工作' })).getAllByRole('row')).toHaveLength(4)
  expect(screen.getByRole('table', { name: '交付成果' })).toBeInTheDocument()
  expect(screen.getByRole('table', { name: '待确认事项' })).toBeInTheDocument()
  const agent = screen.getByTestId('task-workspace-entry-1')
  expect(within(agent).queryByRole('button')).toBeNull()
  fireEvent.click(screen.getByTestId('task-workspace-open-reference-0'))
  expect(open).toHaveBeenCalledWith(
    { kind: 'goal', threadId: 'original-thread', goalId: 'original-goal', revision: 3 },
    target
  )
  expect(
    gateway.client.requests.some(call =>
      ['thread/start', 'thread/resume', 'turn/start'].includes(call.method)
    )
  ).toBe(false)
})

test('explains missing observations, confirmed empty records and historical agent state', async () => {
  const gateway = installTaskWorkspaceGateway(async (method, params) => {
    if (method === 'integrations/scope/read') return nativeScope
    const value = snapshot()
    value.facets = [
      { kind: 'goal', availability: 'available', observedCount: 0, reasonCode: null },
      {
        kind: 'agents',
        availability: 'partial',
        observedCount: 1,
        reasonCode: 'HISTORICAL_AGENTS_SNAPSHOT',
      },
      {
        kind: 'runtime',
        availability: 'unknown',
        observedCount: null,
        reasonCode: 'ORIGINAL_RUNTIME_REFERENCE_REQUIRED',
      },
      {
        kind: 'sources',
        availability: 'unknown',
        observedCount: null,
        reasonCode: 'ORIGINAL_ACCEPTED_TASK_REFERENCE_REQUIRED',
      },
      {
        kind: 'artifacts',
        availability: 'unavailable',
        observedCount: null,
        reasonCode: 'OFFICE_DISABLED',
      },
    ]
    value.entries[1].sourceMethod = 'history/agents'
    return reply(params, value)
  })
  owned.push(gateway)
  await mount()
  selectTask()
  await screen.findByTestId('task-workspace-observation')
  expect(screen.getByTestId('task-workspace-facet-goal')).toHaveTextContent('无记录')
  expect(screen.getByTestId('task-workspace-facet-agents')).toHaveTextContent('历史记录')
  expect(screen.getByTestId('task-workspace-facet-agents')).toHaveTextContent(
    '实时状态可能已经变化'
  )
  expect(screen.getByTestId('task-workspace-facet-runtime')).toHaveTextContent('未选择')
  expect(screen.getByTestId('task-workspace-facet-sources')).toHaveTextContent('未选择')
  expect(screen.getByTestId('task-workspace-facet-artifacts')).toHaveTextContent('未启用')
  expect(screen.getByTestId('task-workspace-entry-1')).toHaveTextContent('上次记录的状态')
  expect(screen.getByTestId('task-workspace-observation')).not.toHaveTextContent(
    'ORIGINAL_RUNTIME_REFERENCE_REQUIRED'
  )
})

test('versioned native events refresh the same original view without a second task or duplicate read', async () => {
  let completed = false
  const gateway = installTaskWorkspaceGateway(async (method, params) => {
    if (method === 'integrations/scope/read') return nativeScope
    const value = snapshot()
    if (completed) value.thread.nativeStatus = 'completed'
    return reply(params, value)
  })
  owned.push(gateway)
  await mount()
  selectTask()
  await screen.findByTestId('task-workspace-observation')
  completed = true
  const observation = {
    scope: nativeScope,
    operationId: 'original-operation',
    entityId: 'original-operation',
    sequence: 1,
    revision: 1,
    observedAtMs: 1234,
    snapshot: false,
    reference: { threadId: 'original-thread', turnId: 'original-turn' },
    state: 'completed',
  }
  await act(async () => {
    gateway.client.emitNotification('integrations/runtime/taskStateChanged', observation)
    await gateway.runtime.notificationQueueByClient.get(gateway.client)
  })
  await waitFor(() =>
    expect(screen.getByTestId('task-workspace-root-status')).toHaveTextContent('已完成')
  )
  const before = gateway.calls.filter(call => call.method === taskMethod).length
  await act(async () => {
    gateway.client.emitNotification('integrations/runtime/taskStateChanged', observation)
    await gateway.runtime.notificationQueueByClient.get(gateway.client)
    await new Promise(resolve => setTimeout(resolve, 20))
  })
  expect(gateway.calls.filter(call => call.method === taskMethod)).toHaveLength(before)
  expect(
    gateway.client.requests.some(call => ['thread/start', 'turn/start'].includes(call.method))
  ).toBe(false)
})

test('host navigation support is checked for each original reference and again when opening', async () => {
  const gateway = installTaskWorkspaceGateway()
  owned.push(gateway)
  const open = vi.fn()
  let supported = true
  await mount({
    onOpenReference: open,
    canOpenReference: reference => supported && reference.kind === 'thread',
  })
  selectTask()
  await screen.findByTestId('task-workspace-open-thread')
  expect(screen.queryByTestId('task-workspace-open-reference-0')).toBeNull()
  expect(screen.queryByTestId('task-workspace-open-reference-2')).toBeNull()
  // A host mapping can disappear after render; clicking cannot reuse that mapping.
  supported = false
  fireEvent.click(screen.getByTestId('task-workspace-open-thread'))
  expect(open).not.toHaveBeenCalled()
  supported = true
  fireEvent.click(screen.getByTestId('task-workspace-open-thread'))
  expect(open).toHaveBeenCalledExactlyOnceWith(
    { kind: 'thread', threadId: 'original-thread' },
    target
  )
})

test('agent navigation requires a dedicated full-run host action, not a generic latest-agent callback', async () => {
  const gateway = installTaskWorkspaceGateway(async (method, params) =>
    method === 'integrations/scope/read'
      ? nativeScope
      : reply(
          params,
          snapshot('original-thread', {
            entries: [
              {
                ...snapshot().entries[1],
                reference: {
                  kind: 'agent',
                  threadId: 'original-thread',
                  agentId: 'original-agent',
                  backgroundRun: {
                    parentSessionId: 'original-thread',
                    agentId: 'original-agent',
                    runId: 'original-native-run',
                  },
                },
              },
            ],
          })
        )
  )
  owned.push(gateway)
  const generic = vi.fn(),
    exact = vi.fn()
  const view = await mount({ onOpenReference: generic })
  selectTask()
  await screen.findByTestId('task-workspace-entry-0')
  expect(screen.queryByTestId('task-workspace-open-reference-0')).toBeNull()
  view.change({ onOpenAgentRun: exact })
  fireEvent.click(screen.getByTestId('task-workspace-open-reference-0'))
  expect(generic).not.toHaveBeenCalled()
  expect(exact).toHaveBeenCalledWith(
    expect.objectContaining({
      backgroundRun: {
        parentSessionId: 'original-thread',
        agentId: 'original-agent',
        runId: 'original-native-run',
      },
    }),
    target
  )
})

test('expired opaque cursors re-read the first native page without replaying execution', async () => {
  let reads = 0
  const gateway = installTaskWorkspaceGateway(async (method, params) => {
    if (method === 'integrations/scope/read') return nativeScope
    reads++
    if ((params.payload as { cursor?: string }).cursor)
      return {
        ...reply(params),
        status: 'rejected',
        result: null,
        error: {
          code: 'TASK_WORKSPACE_CURSOR_EXPIRED',
          recovery: 'retry_read',
          messageKey: 'integration.unavailable',
        },
      }
    return reply(
      params,
      snapshot('original-thread', {
        snapshotId: reads === 1 ? 'first-native-snapshot' : 'fresh-native-snapshot',
        nextCursor: reads === 1 ? 'opaque-native-cursor' : null,
      })
    )
  })
  owned.push(gateway)
  await mount()
  selectTask()
  await screen.findByTestId('task-workspace-observation')
  fireEvent.click(screen.getByTestId('task-workspace-next'))
  await screen.findByTestId('task-workspace-cursor-reset')
  expect(screen.getByTestId('task-workspace-page')).toHaveTextContent('第 1 页')
  expect(
    gateway.calls.filter(call => call.method === taskMethod).map(call => call.params.payload)
  ).toEqual([
    { threadId: 'original-thread' },
    { threadId: 'original-thread', cursor: 'opaque-native-cursor' },
    { threadId: 'original-thread' },
  ])
})

test('cancelling a read discards a late response and never claims the task was stopped', async () => {
  let complete!: () => void
  const gateway = installTaskWorkspaceGateway(async (method, params) =>
    method === 'integrations/scope/read'
      ? nativeScope
      : new Promise(done => {
          complete = () => done(reply(params))
        })
  )
  owned.push(gateway)
  await mount()
  selectTask()
  await waitFor(() => expect(gateway.calls.some(call => call.method === taskMethod)).toBe(true))
  fireEvent.click(screen.getByTestId('task-workspace-cancel-read'))
  await waitFor(() =>
    expect(screen.getByTestId('task-workspace-error')).toHaveTextContent('任务仍按原状态继续')
  )
  await act(async () => {
    complete()
    await Promise.resolve()
  })
  expect(screen.queryByTestId('task-workspace-observation')).toBeNull()
  expect(gateway.calls.filter(call => call.method === taskMethod)).toHaveLength(1)
})

test('changing the target during a read clears selection and cannot publish the previous target response', async () => {
  let complete!: () => void
  const gateway = installTaskWorkspaceGateway(async (method, params) =>
    method === 'integrations/scope/read'
      ? nativeScope
      : new Promise(done => {
          complete = () => done(reply(params))
        })
  )
  owned.push(gateway)
  const view = await mount()
  selectTask()
  await waitFor(() => expect(gateway.calls.some(call => call.method === taskMethod)).toBe(true))
  view.change({
    target: { serverId: 'other-target', workspacePath: '/other-workspace' },
    tasks: [
      { threadId: 'other-original-thread', title: 'Other task', workspacePath: '/other-workspace' },
    ],
  })
  await act(async () => {
    complete()
    await Promise.resolve()
  })
  expect(screen.queryByTestId('task-workspace-observation')).toBeNull()
  expect(screen.getByTestId('task-workspace-thread-select')).toHaveValue('')
})

test('real account lifetime invalidation hides an already loaded observation', async () => {
  const gateway = installTaskWorkspaceGateway()
  owned.push(gateway)
  await mount()
  selectTask()
  await screen.findByTestId('task-workspace-observation')
  act(() => notifyAccountContextChange('local'))
  await waitFor(() => expect(screen.queryByTestId('task-workspace-observation')).toBeNull())
  expect(screen.getByTestId('task-workspace-thread-select')).toHaveValue('')
})

test('English copy and original artifact references use normal host navigation without claiming download', async () => {
  const refs = [{ kind: 'artifact' as const, id: 'original-artifact', revision: '1' },
    { kind: 'artifact' as const, id: 'second-original-artifact', revision: '2' }]
  const gateway = installTaskWorkspaceGateway(async (method, params) =>
    method === 'integrations/scope/read'
      ? nativeScope
      : reply(params, snapshot('original-thread', { artifactRefs: refs }))
  )
  owned.push(gateway)
  const open = vi.fn()
  await mount({ onOpenArtifacts: open }, 'en')
  selectTask()
  await screen.findByTestId('task-workspace-open-artifacts')
  expect(screen.getByRole('heading', { name: 'Task board' })).toBeInTheDocument()
  fireEvent.click(screen.getByTestId('task-workspace-open-artifacts-1'))
  expect(open).toHaveBeenCalledWith([refs[1]], target, 'original-thread')
  expect(screen.queryByText(/downloaded/i)).toBeNull()
})
