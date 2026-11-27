const readySettings = {
  persisted: {
    memoryCenterEnabled: true,
    publicationsEnabled: true,
    businessAutomationEnabled: true,
  },
  effective: {
    memoryCenterEnabled: true,
    publicationsEnabled: true,
    businessAutomationEnabled: true,
  },
  connection: {
    memoryCenterEnabled: true,
    publicationsEnabled: true,
    businessAutomationEnabled: true,
  },
  revision: 'a'.repeat(64),
  restartRequired: false,
}
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, expect, test, vi } from 'vitest'
import { clearTestTransports, installTestTransport } from '@/test/runtime-transport'
import type { RuntimeWorkListResponse, RuntimeTaskAddress } from '@/types/api'
import type { IntegrationRequest } from '../../../../shared/generated/contracts'
import fixtures from '../../../../../../tests/fixtures/integrations/knowledge/contract-fixtures.json'
import { FakeGatewayClient } from '@/kcoder/gateway/runtime/contractFixture.test-support'
import { KCoderGatewayRuntime } from '@/kcoder/gatewayRuntime'

const fixture = vi.hoisted(() => ({
  request: vi.fn(),
  current: () => true,
  state: {
    currentRuntimeTask: null as RuntimeTaskAddress | null,
    runtimeWork: null as RuntimeWorkListResponse | null,
    devices: [
      { device_id: 'local', name: 'Local', is_default: true },
      { device_id: 'other', name: 'Other' },
    ],
  },
}))
vi.mock('@/features/workbench/useWorkbench', () => ({
  useWorkbench: () => ({ state: fixture.state }),
}))
vi.mock('@/kcoder/usePluginTargetScope', () => ({
  usePluginTargetScope: (serverId: string) => ({ key: serverId, isCurrent: fixture.current }),
}))
vi.mock('@/host/localExecutor', () => ({ requestLocalExecutor: fixture.request }))
vi.mock('@/hooks/useTranslation', () => ({ useTranslation: () => ({ t: (key: string) => key }) }))
import { MemoryWorkspace } from './MemoryWorkspace'

const runtimes = new Set<KCoderGatewayRuntime>()
afterEach(async () => {
  cleanup()
  await Promise.all([...runtimes].map(runtime => runtime.disposeAsync()))
  runtimes.clear()
  clearTestTransports()
  fixture.request.mockReset()
  fixture.state.currentRuntimeTask = null
  fixture.state.runtimeWork = null
  localStorage.clear()
})

test('retains an owned native turn locator through the real VM and reads it in the context memory page', async () => {
  installTestTransport(() => undefined)
  const client = new FakeGatewayClient('actual-thread')
  const runtime = new KCoderGatewayRuntime('fixture-transport', {
    loadServers: async () => [
      { id: 'local', label: 'Local', transport: 'local', workspacePath: '/workspace' },
    ],
    createClient: () => client,
  })
  runtimes.add(runtime)
  const created = (await runtime.request('runtime.tasks.create', {
    taskId: 'memory-task',
    executionRequest: { prompt: 'Controlled VM fixture; no real model call' },
  })) as { taskId: string }
  const event = {
    serverId: 'native-process-one',
    threadId: 'actual-thread',
    turnId: 'original-turn',
    attemptId: 'original-attempt',
    sequence: 20,
    memorySnapshotId: 'ignored-flat-alias',
    turn: { id: 'original-turn', attemptId: 'original-attempt', memorySnapshotId: 'fixture-task' },
  }
  client.persistedThreads.push({ id: 'actual-thread', cwd: '/workspace', status: 'active' })
  await runtime.forwardNotification('turn/started', event, 'local', client)
  const updateVM = async () => {
    const listed = (await runtime.request('runtime.tasks.list', {})) as {
      workspaces: RuntimeWorkListResponse['chats']
    }
    fixture.state.currentRuntimeTask = {
      deviceId: 'local',
      taskId: created.taskId,
      workspacePath: '/workspace',
    }
    fixture.state.runtimeWork = { projects: [], chats: listed.workspaces, totalTasks: 1 }
    return listed.workspaces
      .flatMap(workspace => workspace.tasks)
      .find(task => task.taskId === created.taskId)!
  }
  let task = await updateVM()
  expect(task.runtimeHandle?.memoryTaskSnapshot).toMatchObject({
    snapshotId: 'fixture-task',
    threadId: 'actual-thread',
    sequence: 20,
  })
  const snapshot = structuredClone(fixtures.MemoryTaskSnapshot.valid[0].value)
  snapshot.memories[0].proposal.title = 'Original accepted task memory'
  snapshot.memories[0].proposal.content =
    'Original reviewed content, frozen before the provider request.'
  const nativeScope = { ...snapshot.owner, identityGeneration: '1', targetRevision: '1' }
  fixture.request.mockImplementation(
    async (_method, params: { method: string; params: IntegrationRequest }) => {
      if (params.method === 'settings/integrations/knowledge/read') return readySettings
      if (params.method === 'integrations/scope/read') return nativeScope
      const request = params.params
      return {
        contractVersion: 'parallel-v1',
        requestId: request.requestId,
        operationId: null,
        entityRevision: null,
        observedAt: '2026-10-24T00:00:00Z',
        status: 'completed',
        error: null,
        result:
          params.method === 'integrations/memory/readTaskSnapshot'
            ? { snapshot }
            : { page: { items: [], nextCursor: null } },
      }
    }
  )
  const view = render(<MemoryWorkspace includeKnowledge />)
  const panel = (await screen.findByTestId('memory-task-selection')) as HTMLDetailsElement
  expect(
    fixture.request.mock.calls.some(
      call => call[1].method === 'integrations/memory/readTaskSnapshot'
    )
  ).toBe(false)
  panel.open = true
  fireEvent(panel, new Event('toggle'))
  await within(panel).findByText('Original accepted task memory')
  expect(within(panel).getByText(snapshot.memories[0].proposal.content)).toBeInTheDocument()
  expect(fixture.request).toHaveBeenCalledWith(
    'runtime.integrations.request',
    expect.objectContaining({
      serverId: 'local',
      workspacePath: '/workspace',
      method: 'integrations/memory/readTaskSnapshot',
      params: expect.objectContaining({
        payload: { threadId: 'actual-thread', taskId: 'fixture-task' },
        operationId: undefined,
      }),
    }),
    expect.anything()
  )

  await runtime.forwardNotification(
    'turn/started',
    { ...event, sequence: 21, turn: { ...event.turn, memorySnapshotId: 'wrong-client-snapshot' } },
    'local',
    new FakeGatewayClient('actual-thread')
  )
  await runtime.forwardNotification(
    'turn/started',
    { ...event, sequence: 19, turn: { ...event.turn, memorySnapshotId: 'old-event-snapshot' } },
    'local',
    client
  )
  task = await updateVM()
  expect(task.runtimeHandle?.memoryTaskSnapshot).toMatchObject({
    snapshotId: 'fixture-task',
    sequence: 20,
  })
  view.rerender(<MemoryWorkspace includeKnowledge />)
  expect(screen.getByText('Original accepted task memory')).toBeInTheDocument()

  fireEvent.change(screen.getByRole('combobox'), { target: { value: 'other' } })
  await waitFor(() => expect(screen.queryByTestId('memory-task-selection')).not.toBeInTheDocument())
  expect(screen.queryByText('Original accepted task memory')).not.toBeInTheDocument()
  fireEvent.change(screen.getByRole('combobox'), { target: { value: 'local' } })
  await screen.findByTestId('memory-task-selection')
  await runtime.forwardNotification(
    'turn/started',
    {
      ...event,
      serverId: 'native-process-two',
      sequence: 1,
      turnId: 'restarted-turn',
      attemptId: 'restarted-attempt',
      turn: {
        id: 'restarted-turn',
        attemptId: 'restarted-attempt',
        memorySnapshotId: 'fixture-task',
      },
    },
    'local',
    client
  )
  await runtime.forwardNotification(
    'turn/started',
    {
      ...event,
      sequence: 999,
      turn: { ...event.turn, memorySnapshotId: 'retired-server-snapshot' },
    },
    'local',
    client
  )
  task = await updateVM()
  expect(task.runtimeHandle?.memoryTaskSnapshot).toMatchObject({
    snapshotId: 'fixture-task',
    serverInstanceId: 'native-process-two',
    sequence: 1,
  })
  await runtime.forwardNotification(
    'turn/started',
    {
      ...event,
      turnId: 'new-turn',
      attemptId: 'new-attempt',
      serverId: 'native-process-two',
      sequence: 2,
      turn: { id: 'new-turn', attemptId: 'new-attempt', memorySnapshotId: null },
    },
    'local',
    client
  )
  await updateVM()
  view.rerender(<MemoryWorkspace includeKnowledge />)
  await waitFor(() => expect(screen.queryByTestId('memory-task-selection')).not.toBeInTheDocument())
  runtime.invalidateAccountTarget('local')
  expect(runtime.tasks.has(created.taskId)).toBe(false)
})
