import { StrictMode } from 'react'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import { createInstance } from 'i18next'
import { I18nextProvider } from 'react-i18next'
import { clearTestTransports, installTestTransport } from '@/test/runtime-transport'
import { TaskMemberViewer, type TaskMemberViewerProps } from './TaskMemberViewer'
import { taskMemberResources } from './locales'
import zhCommon from '@/i18n/locales/zh-CN/common'
import enCommon from '@/i18n/locales/en/common'
const address = {
  runtime: 'kcoder' as const,
  deviceId: 'local',
  taskId: 'original-task',
  threadId: 'original-parent',
  workspacePath: '/owned',
}
const run = { parentSessionId: 'original-parent', agentId: 'original-child', runId: 'original-run' }
vi.mock('@/kcoder/gatewayRpc', async original => ({
  ...(await original<object>()),
  fetchGatewayServers: async () => [
    { id: 'local', label: 'Owned', transport: 'local', runtime: 'kcoder', workspacePath: '/owned' },
  ],
}))
beforeEach(() => {
  localStorage.clear()
  installTestTransport(() => undefined)
  vi.spyOn(HTMLElement.prototype, 'clientHeight', 'get').mockReturnValue(800)
  vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockReturnValue(1000)
  vi.spyOn(HTMLElement.prototype, 'offsetWidth', 'get').mockReturnValue(1000)
  vi.spyOn(HTMLElement.prototype, 'offsetHeight', 'get').mockReturnValue(800)
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue({
    x: 0,
    y: 0,
    left: 0,
    top: 0,
    right: 1000,
    bottom: 800,
    width: 1000,
    height: 800,
    toJSON() {
      return {}
    },
  })
})
afterEach(() => {
  cleanup()
  clearTestTransports()
  vi.restoreAllMocks()
})
function api() {
  return {
    listRuntimeSubagents: vi.fn(async () => ({
      threadId: run.parentSessionId,
      journalScope: 'native-scope',
      capabilities: {
        artifacts: true,
        publicTranscript: true,
        pages: true,
        live: true,
        conversationStream: true,
        exactRun: true,
        receipts: true,
        steering: true,
        stop: true,
      },
      agents: [
        {
          agentId: run.agentId,
          agentName: 'Exact original member',
          status: 'completed',
          acceptingMessages: false,
          queueDepth: 0,
          backgroundRun: run,
        },
      ],
    })),
    subscribeRuntimeSubagentConversation: vi.fn(async () => ({
      snapshot: {
        threadId: run.parentSessionId,
        agentId: run.agentId,
        subscriptionId: 'actual-observer',
        runId: run.runId,
        sequence: 1,
        active: false,
        status: 'completed',
        messages: [
          {
            id: 'a',
            role: 'assistant' as const,
            content: 'Original complete response',
            status: 'done' as const,
            createdAt: '',
          },
        ],
      },
      unsubscribe: vi.fn(async () => {}),
    })),
    readSubagentArtifact: vi.fn(async () => ({
      offset: 0,
      revision: 'original-file',
      size: 25,
      content: 'Original completed output',
      truncated: false,
      name: 'output.md',
      path: '/owned/native-output',
      backgroundRun: run,
    })),
  }
}
async function mount(next: Partial<TaskMemberViewerProps> = {}, language = 'zh-CN') {
  const service = api(),
    onClose = vi.fn()
  const i18n = createInstance()
  await i18n.init({
    lng: language,
    resources: {
      'zh-CN': { taskMembers: taskMemberResources['zh-CN'], common: zhCommon },
      en: { taskMembers: taskMemberResources.en, common: enCommon },
    },
    interpolation: { escapeValue: false },
  })
  const component = (changed: Partial<TaskMemberViewerProps> = {}) => (
    <StrictMode>
      <I18nextProvider i18n={i18n}>
        <TaskMemberViewer
          api={service}
          address={address}
          run={run}
          parentLabel="Original parent task"
          onClose={onClose}
          {...next}
          {...changed}
        />
      </I18nextProvider>
    </StrictMode>
  )
  const view = render(component())
  return {
    ...view,
    service,
    onClose,
    change(changed: Partial<TaskMemberViewerProps>) {
      view.rerender(component(changed))
    },
  }
}
test('reuses the normal complete member conversation with full original run and explicit parent navigation', async () => {
  const back = vi.fn()
  const view = await mount({ onOpenParent: back })
  await waitFor(() =>
    expect(screen.getByTestId('subagent-workspace-records')).toHaveTextContent(
      'Original complete response'
    )
  )
  expect(view.service.listRuntimeSubagents).toHaveBeenCalledWith({
    address,
    agentId: run.agentId,
    expectedBackgroundRun: run,
  })
  expect(view.service.subscribeRuntimeSubagentConversation.mock.calls.at(-1)?.[0]).toMatchObject({
    address,
    agentId: run.agentId,
    expectedBackgroundRun: run,
  })
  expect(screen.queryByTestId('subagent-workspace-input')).toBeNull()
  expect(screen.queryByTestId('subagent-workspace-stop')).toBeNull()
  fireEvent.click(screen.getByTestId('subagent-workspace-back'))
  expect(view.onClose).toHaveBeenCalledOnce()
  expect(back).toHaveBeenCalledWith(address)
})
test('an older host stays unavailable and never falls back to a newer member', async () => {
  const service = api()
  service.listRuntimeSubagents.mockResolvedValue({
    ...(await service.listRuntimeSubagents()),
    capabilities: { ...(await service.listRuntimeSubagents()).capabilities, exactRun: false },
  })
  service.listRuntimeSubagents.mockClear()
  await mount({ api: service }, 'en')
  await waitFor(() =>
    expect(screen.getByRole('alert')).toHaveTextContent('exact member run is unavailable')
  )
  expect(service.subscribeRuntimeSubagentConversation).not.toHaveBeenCalled()
  expect(service.readSubagentArtifact).not.toHaveBeenCalled()
})

test('a paused original member can stop without an active response stream', async () => {
  const base = api()
  const original = await base.listRuntimeSubagents()
  const snapshot = await base.subscribeRuntimeSubagentConversation()
  const stopped = vi.fn(async () => ({ stopped: true, status: 'stopped', expectedBackgroundRun: run }))
  const service = {
    ...base,
    listRuntimeSubagents: vi.fn(async () => ({ ...original,
      capabilities: { ...original.capabilities, exactControl: true },
      agents: [{ ...original.agents[0], status: 'paused', presentation: {
        canStop: true, journalScope: 'native-paused', goal: 'Paused original member',
      } }],
    })),
    subscribeRuntimeSubagentConversation: vi.fn(async () => ({ ...snapshot,
      snapshot: { ...snapshot.snapshot, active: false, status: 'paused' },
    })),
    readRuntimeSubagentCommand: vi.fn(async (value: { clientMessageId: string }) => ({
      threadId: run.parentSessionId, agentId: run.agentId, clientMessageId: value.clientMessageId, receiptEpoch: 0,
    })),
    steerRuntimeSubagent: vi.fn(async () => ({ agentId: run.agentId, accepted: false, queued: false, status: 'rejected' })),
    stopRuntimeSubagent: stopped,
  }
  await mount({ api: service })
  fireEvent.click(await screen.findByTestId('subagent-workspace-stop'))
  await waitFor(() => expect(stopped).toHaveBeenCalledWith({ address, agentId: run.agentId, expectedBackgroundRun: run }))
  expect(service.steerRuntimeSubagent).not.toHaveBeenCalled()
})
test('a late response from the previous full run cannot replace the newly selected owner', async () => {
  let release!: (value: unknown) => void
  const service = api()
  const value = await service.listRuntimeSubagents()
  service.listRuntimeSubagents.mockImplementation(
    () =>
      new Promise(done => {
        release = done as (value: unknown) => void
      })
  )
  const view = await mount({ api: service })
  await waitFor(() => expect(release).toBeTypeOf('function'))
  const nextRun = { ...run, runId: 'next-explicit-run' }
  service.listRuntimeSubagents.mockRejectedValue(new Error('No exact new run'))
  view.change({ run: nextRun })
  await act(async () => {
    release(value)
    await Promise.resolve()
  })
  await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent('精确成员运行'))
  expect(screen.queryByTestId('subagent-workspace-records')).toBeNull()
  expect(service.subscribeRuntimeSubagentConversation).not.toHaveBeenCalled()
})
