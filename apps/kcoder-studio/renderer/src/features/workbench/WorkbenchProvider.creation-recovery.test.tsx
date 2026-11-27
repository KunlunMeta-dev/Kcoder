import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { useState } from 'react'
import { ModelConfigurationRequiredError, TaskCreationRejectedError } from '@/kcoder/runtimeTaskCreationError'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { WorkbenchProvider, type WorkbenchServices } from './WorkbenchProvider'
import { WorkbenchProbeSessionProvider } from './WorkbenchProvider.render.test-support'
import { useWorkbench } from './useWorkbench'
import {
  ProjectSendProbe,
  clearGatewayRuntime,
  createRuntimeWork,
  createRuntimeWorkApiMock,
  createWorkbenchServices,
} from './WorkbenchProvider.test-support'
import { clearRuntimeConversationCacheForTests } from './runtimeConversationCache'
import { updateVerifiedAccountContextScope } from '@/kcoder/accountContextEvents'
import { readComposerDraft } from './pendingInputStorage'

const localExecutorMocks = vi.hoisted(() => ({
  connectLocalExecutorToBackend: vi.fn().mockResolvedValue({ running: true, ready: true }),
  disconnectLocalExecutorFromBackend: vi.fn().mockResolvedValue({ running: true, ready: true }),
  ensureLocalExecutorStarted: vi.fn(),
  requestLocalExecutor: vi.fn(),
  subscribeLocalExecutorEvents: vi.fn(),
}))

vi.mock('@/host/localExecutor', () => ({
  connectLocalExecutorToBackend: localExecutorMocks.connectLocalExecutorToBackend,
  disconnectLocalExecutorFromBackend: localExecutorMocks.disconnectLocalExecutorFromBackend,
  ensureLocalExecutorStarted: localExecutorMocks.ensureLocalExecutorStarted,
  requestLocalExecutor: localExecutorMocks.requestLocalExecutor,
  subscribeLocalExecutorEvents: localExecutorMocks.subscribeLocalExecutorEvents,
}))

const preCreationFailures = [
  new ModelConfigurationRequiredError('device-1', new Error('missing provider')),
  new TaskCreationRejectedError('MCP setup failed', new Error('MCP unavailable'), { kind: 'creation-rejected', deviceId: 'device-1' }),
]

function CreationRequestProbe() {
  const workbench = useWorkbench()
  const [sendResult, setSendResult] = useState('idle')
  const [error, setError] = useState('')
  const [recoveryTarget, setRecoveryTarget] = useState('')
  const runtimeTasks = [
    ...(workbench.state.runtimeWork?.projects.flatMap(project =>
      project.deviceWorkspaces.flatMap(workspace => workspace.tasks)
    ) ?? []),
    ...(workbench.state.runtimeWork?.chats.flatMap(workspace => workspace.tasks) ?? []),
  ]
  const failedTask = runtimeTasks.find(task => task.creationRequest)
  const creationRequest = failedTask?.creationRequest ?? null

  const send = async (clientMessageId?: string) => {
    const result = await workbench.sendCurrentInput('修复 CI', {
      ...(clientMessageId ? { clientMessageId } : {}),
      onError: (message, recovery) => {
        setError(message)
        setRecoveryTarget(recovery?.deviceId ?? '')
      },
    })
    setSendResult(result === false ? 'blocked' : 'accepted')
  }

  return (
    <div>
      <button type="button" onClick={() => workbench.projectChat.setInput('')}>clear draft</button>
      <button type="button" onClick={() => workbench.projectChat.restoreInput?.('retained objective')}>restore goal draft</button>
      <output data-testid="creation-request">{JSON.stringify(creationRequest)}</output>
      <output data-testid="creation-send-result">{sendResult}</output>
      <output data-testid="creation-error">{error}</output>
      <output data-testid="creation-recovery-target">{recoveryTarget}</output>
      <button type="button" onClick={() => void send()}>
        create first without request id
      </button>
      <button
        type="button"
        disabled={!creationRequest}
        onClick={() => {
          if (creationRequest) void send(creationRequest.clientMessageId)
        }}
      >
        send same retained client message
      </button>
      <button
        type="button"
        disabled={creationRequest?.outcome !== 'rejected'}
        onClick={() => void send()}
      >
        create new after rejection
      </button>
    </div>
  )
}

function renderCreationRecoveryProbe(runtimeWorkApi: ReturnType<typeof createRuntimeWorkApiMock>) {
  const services = createWorkbenchServices({
    runtimeWorkApi: runtimeWorkApi as WorkbenchServices['runtimeWorkApi'],
  })

  return render(
    <WorkbenchProvider user={{ id: 1, user_name: 'alice', email: 'a@b.c' }} services={services}>
      <WorkbenchProbeSessionProvider><ProjectSendProbe /></WorkbenchProbeSessionProvider>
      <CreationRequestProbe />
    </WorkbenchProvider>
  )
}

function readCreationRequest() {
  const value = screen.getByTestId('creation-request').textContent
  return JSON.parse(value || 'null') as {
    clientRequestId: string
    clientMessageId: string
    outcome: 'unknown' | 'rejected'
  } | null
}

async function selectProject() {
  await waitFor(() => expect(screen.getByText('select project')).toBeInTheDocument())
  await userEvent.click(screen.getByText('select project'))
  await waitFor(() => expect(screen.getByTestId('current-project-name')).toHaveTextContent('Wegent'))
}

describe('WorkbenchProvider task creation recovery', () => {
  beforeEach(() => {
    vi.useRealTimers()
    delete window.__KCODER_STUDIO_RUNTIME_CONFIG__
    clearGatewayRuntime()
    window.history.pushState({}, '', '/')
    localStorage.clear()
    sessionStorage.clear()
    vi.clearAllMocks()
    localExecutorMocks.ensureLocalExecutorStarted.mockResolvedValue({
      running: true,
      ready: true,
      deviceId: 'local-device',
    })
    localExecutorMocks.requestLocalExecutor.mockImplementation(async (method: string) => {
      if (method === 'runtime.tasks.list') return { projects: [], chats: [], totalTasks: 0 }
      return {}
    })
    localExecutorMocks.subscribeLocalExecutorEvents.mockResolvedValue(vi.fn())
  })

  afterEach(() => {
    vi.useRealTimers()
    vi.restoreAllMocks()
    clearRuntimeConversationCacheForTests()
  })

  test('restores an empty goal draft without overwriting a newly edited draft', async () => {
    renderCreationRecoveryProbe(createRuntimeWorkApiMock())
    await selectProject()
    await userEvent.click(screen.getByText('restore goal draft'))
    expect(screen.getByTestId('composer-input')).toHaveTextContent('retained objective')
    await userEvent.click(screen.getByText('set input'))
    await userEvent.click(screen.getByText('restore goal draft'))
    expect(screen.getByTestId('composer-input')).toHaveTextContent('修复 CI')
    await userEvent.click(screen.getByText('clear draft'))
    await userEvent.click(screen.getByText('restore goal draft'))
    expect(screen.getByTestId('composer-input')).toHaveTextContent('retained objective')
  })

  test('a cold workbench restores unsent task text without sending it and persists an explicit clear', async () => {
    updateVerifiedAccountContextScope('device-1', 'draft-account')
    const api = createRuntimeWorkApiMock()
    const first = renderCreationRecoveryProbe(api)
    await selectProject()
    await userEvent.click(screen.getByText('open project runtime task'))
    await waitFor(() => expect(screen.getByTestId('current-runtime-task-address')).toHaveTextContent('device-1:runtime-a'))
    await userEvent.click(screen.getByText('set input'))
    await waitFor(() => expect(readComposerDraft('device-1:runtime-a')).toBe('修复 CI'))
    first.unmount()
    sessionStorage.clear()
    window.history.replaceState({}, '', '/')

    renderCreationRecoveryProbe(api)
    await selectProject()
    await userEvent.click(screen.getByText('open project runtime task'))
    await waitFor(() => expect(screen.getByTestId('composer-input')).toHaveTextContent('修复 CI'))
    expect(api.createRuntimeTask).not.toHaveBeenCalled()
    expect(api.sendRuntimeMessage).not.toHaveBeenCalled()
    await userEvent.click(screen.getByText('clear draft'))
    await waitFor(() => expect(readComposerDraft('device-1:runtime-a')).toBeNull())
  })

  test('retains the actual first-create IDs and does not recreate after an unknown result', async () => {
    const runtimeWorkApi = createRuntimeWorkApiMock({
      createRuntimeTask: vi.fn().mockRejectedValue(new Error('synthetic create transport loss')),
    })
    renderCreationRecoveryProbe(runtimeWorkApi)
    await selectProject()

    await userEvent.click(screen.getByText('create first without request id'))
    await waitFor(() => expect(runtimeWorkApi.createRuntimeTask).toHaveBeenCalledTimes(1))
    await waitFor(() => expect(readCreationRequest()?.outcome).toBe('unknown'))

    const request = runtimeWorkApi.createRuntimeTask.mock.calls[0][0] as {
      taskId: string
      clientMessageId: string
    }
    const retained = readCreationRequest()
    expect(request.clientMessageId).toBe(`initial:${request.taskId}`)
    expect(retained).toEqual({
      clientRequestId: request.taskId,
      clientMessageId: request.clientMessageId,
      outcome: 'unknown',
      failedAt: expect.any(String),
    })
    expect(screen.getByTestId('runtime-task-statuses')).toHaveTextContent('failed')

    await userEvent.click(screen.getByText('send same retained client message'))
    await waitFor(() =>
      expect(screen.getByTestId('creation-send-result')).toHaveTextContent('blocked')
    )
    expect(runtimeWorkApi.createRuntimeTask).toHaveBeenCalledTimes(1)
    expect(readCreationRequest()).toEqual(retained)
  })

  test.each(preCreationFailures)('returns known pre-creation rejection to its composer: %s', async failure => {
    const runtimeWorkApi = createRuntimeWorkApiMock({
      createRuntimeTask: vi.fn().mockRejectedValue(failure),
    })
    renderCreationRecoveryProbe(runtimeWorkApi)
    await selectProject()

    await userEvent.click(screen.getByText('create first without request id'))
    await waitFor(() => expect(screen.getByTestId('creation-send-result')).toHaveTextContent('blocked'))
    expect(readCreationRequest()).toBeNull()
    expect(screen.getByTestId('runtime-task-statuses')).not.toHaveTextContent('failed')
    expect(screen.getByTestId('creation-error')).not.toBeEmptyDOMElement()
    expect(screen.getByTestId('creation-recovery-target')).toHaveTextContent('device-1')
    expect(screen.getByTestId('current-runtime-task-address')).toHaveTextContent('none')
    expect(runtimeWorkApi.createRuntimeTask).toHaveBeenCalledTimes(1)
  })

  test.each(preCreationFailures)('retains the pre-creation error after the optimistic pane unmounts: %s', async failure => {
    const runtimeWorkApi = createRuntimeWorkApiMock({
      createRuntimeTask: vi.fn().mockRejectedValue(failure),
    })
    renderCreationRecoveryProbe(runtimeWorkApi)
    await selectProject()
    await userEvent.click(screen.getByText('set input'))
    await userEvent.click(screen.getByText('send', { exact: true }))
    await waitFor(() => expect(runtimeWorkApi.createRuntimeTask).toHaveBeenCalledTimes(1))
    await waitFor(() => expect(screen.getByTestId('pane-session-error')).not.toBeEmptyDOMElement())
    expect(screen.getByTestId('composer-input')).toHaveTextContent('修复 CI')
    expect(screen.getByTestId('workbench-error')).toBeEmptyDOMElement()
    expect(readCreationRequest()).toBeNull()
    await userEvent.click(screen.getByText('open runtime b', { exact: true }))
    await waitFor(() => expect(screen.getByTestId('pane-session-error')).toBeEmptyDOMElement())
  })

  test('allows a new creation when the first request was explicitly rejected', async () => {
    const createRuntimeTask = vi
      .fn()
      .mockImplementationOnce(async (request: { taskId: string; deviceId: string; workspacePath?: string; runtime: string }) => ({
        accepted: false,
        deviceId: request.deviceId,
        taskId: request.taskId,
        workspacePath: request.workspacePath,
        runtime: request.runtime,
        error: 'synthetic explicit rejection',
      }))
      .mockImplementationOnce(async (request: { taskId: string; deviceId: string; workspacePath?: string; runtime: string }) => ({
        accepted: true,
        deviceId: request.deviceId,
        taskId: request.taskId,
        workspacePath: request.workspacePath,
        runtime: request.runtime,
      }))
    const runtimeWorkApi = createRuntimeWorkApiMock({ createRuntimeTask })
    renderCreationRecoveryProbe(runtimeWorkApi)
    await selectProject()

    await userEvent.click(screen.getByText('create first without request id'))
    await waitFor(() => expect(createRuntimeTask).toHaveBeenCalledTimes(1))
    await waitFor(() => expect(readCreationRequest()?.outcome).toBe('rejected'))
    const firstRequest = createRuntimeTask.mock.calls[0][0] as {
      taskId: string
      clientMessageId: string
    }
    expect(readCreationRequest()).toEqual({
      clientRequestId: firstRequest.taskId,
      clientMessageId: firstRequest.clientMessageId,
      outcome: 'rejected',
      failedAt: expect.any(String),
    })

    await userEvent.click(screen.getByText('create new after rejection'))
    await waitFor(() => expect(createRuntimeTask).toHaveBeenCalledTimes(2))
    const secondRequest = createRuntimeTask.mock.calls[1][0] as {
      taskId: string
      clientMessageId: string
    }
    expect(secondRequest.taskId).not.toBe(firstRequest.taskId)
    expect(secondRequest.clientMessageId).toBe(`initial:${secondRequest.taskId}`)
    await waitFor(() =>
      expect(screen.getByTestId('current-runtime-task-address')).toHaveTextContent(
        `device-1:${secondRequest.taskId}`
      )
    )
  })

  test('keeps an accepted task open when refreshing the work list fails', async () => {
    let rejectRefresh = false
    let rejectedRefreshCount = 0
    const listRuntimeWork = vi.fn(async () => {
      if (rejectRefresh) {
        rejectedRefreshCount += 1
        throw new Error('synthetic work list refresh failure')
      }
      return createRuntimeWork()
    })
    const createRuntimeTask = vi.fn(async (request: {
      taskId: string
      deviceId: string
      workspacePath?: string
      runtime: string
    }) => {
      rejectRefresh = true
      return {
        accepted: true,
        deviceId: request.deviceId,
        taskId: request.taskId,
        workspacePath: request.workspacePath,
        runtime: request.runtime,
      }
    })
    const runtimeWorkApi = createRuntimeWorkApiMock({ listRuntimeWork, createRuntimeTask })
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    renderCreationRecoveryProbe(runtimeWorkApi)
    await selectProject()

    await userEvent.click(screen.getByText('create first without request id'))
    await waitFor(() => expect(createRuntimeTask).toHaveBeenCalledTimes(1))
    await waitFor(() => expect(rejectedRefreshCount).toBeGreaterThan(0))

    const request = createRuntimeTask.mock.calls[0][0] as { taskId: string; clientMessageId: string }
    expect(request.clientMessageId).toBe(`initial:${request.taskId}`)
    await waitFor(() =>
      expect(screen.getByTestId('current-runtime-task-address')).toHaveTextContent(
        `device-1:${request.taskId}`
      )
    )
    expect(screen.getByTestId('runtime-task-titles')).toHaveTextContent('修复 CI')
    expect(screen.getByTestId('runtime-task-statuses')).not.toHaveTextContent('failed')
    expect(screen.getByTestId('runtime-task-errors')).not.toHaveTextContent(
      'synthetic work list refresh failure'
    )
    expect(readCreationRequest()).toBeNull()
    expect(warn).toHaveBeenCalled()
  })
})
