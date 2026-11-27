import { afterEach, describe, expect, test, vi } from 'vitest'
import { createLocalAppServices } from '@/api/local/localServices'
import { filterDisconnectedRemoteRuntimeWork } from '@/features/workbench/workbenchCloudStatus'

describe('KCoder gateway service routing', () => {
  afterEach(() => {
    document.head.innerHTML = ''
    vi.unstubAllGlobals()
  })

  test('preserves gateway devices through the real local service boundary', async () => {
    document.head.innerHTML = '<meta name="kcoder-rpc-token" content="token">'
    vi.stubGlobal(
      'fetch',
      vi.fn().mockImplementation(async (url: string) => ({
        ok: true,
        json: async () =>
          url === '/api/servers/status'
            ? {
                statuses: [
                  { id: 'local', status: 'online', latencyMs: 5 },
                  { id: 'build-01', status: 'online', latencyMs: 20 },
                ],
              }
            : {
                servers: [
                  {
                    id: 'local',
                    label: '当前虚拟机',
                    description: '本机',
                    transport: 'local',
                    workspacePath: '/workspace',
                  },
                  {
                    id: 'build-01',
                    label: '构建服务器',
                    description: 'SSH',
                    transport: 'ssh',
                    host: 'build-01',
                    workspacePath: '/srv/project',
                  },
                ],
              },
      }))
    )
    let executorEventHandler: ((event: { event: string; payload: unknown }) => void) | null = null
    const request = vi.fn(async (method: string, data: Record<string, unknown> = {}) => {
      if (method === 'runtime.tasks.list') {
        return {
          workspaces: [
            {
              workspacePath: '/workspace',
              label: '当前虚拟机',
              projectKey: 'kcoder:local',
              projectActive: true,
              workspaceSource: 'local',
              deviceId: 'local',
              tasks: [],
            },
            {
              workspacePath: '/srv/project',
              label: '构建服务器',
              projectKey: 'kcoder:build-01',
              projectActive: false,
              workspaceSource: 'local',
              deviceId: 'build-01',
              tasks: [],
            },
          ],
        }
      }
      if (method === 'device.execute_command') {
        if (data.command_key === 'git_is_worktree') {
          return { success: true, exitCode: 0, stdout: 'true', stderr: '' }
        }
        return { success: true, exitCode: 0, stdout: '/srv/project\n', stderr: '' }
      }
      if (method === 'runtime.worktrees.prepare') {
        return {
          success: true,
          path: '/srv/worktrees/remote-git',
          worktree: { path: '/srv/worktrees/remote-git' },
        }
      }
      if (method === 'runtime.tasks.create' || method === 'runtime.tasks.send') {
        return { accepted: true, taskId: 'remote-task' }
      }
      return {}
    })
    const services = createLocalAppServices({
      ensure: async () => ({
        running: true,
        ready: true,
        deviceId: 'local',
        runtimeInstanceId: 'kcoder-gateway:local',
      }),
      request,
      subscribe: async handler => {
        executorEventHandler = handler
        return () => undefined
      },
    })

    await expect(services.deviceApi.listDevices()).resolves.toMatchObject([
      {
        device_id: 'local',
        name: '当前虚拟机',
        status: 'online',
        device_type: 'remote',
        capabilities: expect.arrayContaining(['kcoder-gateway', 'kcoder-gateway-local']),
        runtime_routes: [{ kind: 'remote-relay', runtime_device_id: 'local' }],
      },
      {
        device_id: 'build-01',
        name: '构建服务器',
        status: 'online',
        capabilities: expect.not.arrayContaining(['kcoder-gateway-local']),
        runtime_routes: [{ kind: 'remote-relay', runtime_device_id: 'build-01' }],
      },
    ])
    expect(services.workspaceSessionApi?.createRemoteTerminalClient).toBeTypeOf('function')
    await expect(services.deviceApi.getHomeDirectory('build-01')).resolves.toBe('/srv/project')
    expect(request).toHaveBeenCalledWith(
      'device.execute_command',
      expect.objectContaining({ deviceId: 'build-01', command_key: 'home_dir' })
    )
    const runtimeWork = await services.runtimeWorkApi!.listRuntimeWork()
    expect(runtimeWork).toMatchObject({
      projects: [
        {
          project: { key: 'kcoder:local', stateDeviceId: 'local' },
          deviceWorkspaces: [{ deviceId: 'local', available: true }],
        },
        {
          project: { key: 'kcoder:build-01', stateDeviceId: 'build-01' },
          deviceWorkspaces: [{ deviceId: 'build-01', deviceStatus: 'online', available: true }],
        },
      ],
    })
    expect(filterDisconnectedRemoteRuntimeWork(runtimeWork).projects).toHaveLength(2)
    const projectIds = runtimeWork.projects.map(item => item.project.id)
    await services.runtimeWorkApi?.createRuntimeTask({
      teamId: 0,
      workspacePath: '/srv/project',
      taskId: 'remote-task',
      runtime: 'kcoder',
      message: 'create remotely',
      title: 'Remote task',
      runtimeProjectKey: 'kcoder:build-01',
    })
    const createPayload = request.mock.calls.find(
      ([method]) => method === 'runtime.tasks.create'
    )?.[1]
    expect(createPayload).toMatchObject({
      deviceId: 'build-01',
      runtimeProjectKey: 'kcoder:build-01',
      executionRequest: {
        device_id: 'build-01',
        runtime_project_key: 'kcoder:build-01',
      },
    })
    await services.runtimeWorkApi?.createRuntimeTask({
      teamId: 0,
      workspacePath: '/srv/project',
      taskId: 'remote-git-task',
      runtime: 'kcoder',
      message: 'create remote worktree',
      title: 'Remote worktree',
      runtimeProjectKey: 'kcoder:build-01',
      execution: { workspace: { source: 'git_worktree', branch: 'main' } },
    })
    expect(request).toHaveBeenCalledWith(
      'device.execute_command',
      expect.objectContaining({ deviceId: 'build-01', command_key: 'git_is_worktree' })
    )
    expect(request).toHaveBeenCalledWith(
      'runtime.worktrees.prepare',
      expect.objectContaining({ deviceId: 'build-01', sourcePath: '/srv/project' })
    )
    await services.runtimeWorkApi?.sendRuntimeMessage({
      address: {
        deviceId: 'build-01',
        taskId: 'remote-task',
        threadId: 'remote-thread',
        workspacePath: '/srv/project',
      },
      message: 'continue remotely',
    })
    expect(request).toHaveBeenCalledWith(
      'runtime.tasks.send',
      expect.objectContaining({
        address: expect.objectContaining({ deviceId: 'build-01' }),
        executionRequest: expect.objectContaining({ device_id: 'build-01' }),
      })
    )
    const onChatStart = vi.fn()
    const unsubscribe = services.chatStream.subscribe({
      scope: { taskId: 'remote-task', deviceId: 'build-01' },
      onChatStart,
    })
    await Promise.resolve()
    executorEventHandler?.({
      event: 'response.created',
      payload: { taskId: 'remote-task', deviceId: 'local', data: {} },
    })
    executorEventHandler?.({
      event: 'response.created',
      payload: { taskId: 'remote-task', deviceId: 'build-01', data: {} },
    })
    expect(onChatStart).toHaveBeenCalledTimes(1)
    unsubscribe()
    const remoteAddress = {
      deviceId: 'build-01',
      taskId: 'remote-task',
      threadId: 'remote-thread',
      workspacePath: '/srv/project',
    }
    await services.runtimeWorkApi?.compactRuntimeTask({ address: remoteAddress })
    await services.runtimeWorkApi?.guideRuntimeTask({
      address: remoteAddress,
      message: 'continue remotely',
    })
    await services.runtimeWorkApi?.steerRuntimeSubagent({
      address: remoteAddress,
      agentId: 'agent-target',
      message: 'change only the target',
      clientMessageId: 'client-1',
    })
    expect(request).toHaveBeenCalledWith(
      'runtime.tasks.compact',
      expect.objectContaining({ address: expect.objectContaining({ deviceId: 'build-01' }) })
    )
    expect(request).toHaveBeenCalledWith(
      'runtime.tasks.guidance',
      expect.objectContaining({ address: expect.objectContaining({ deviceId: 'build-01' }) })
    )
    expect(request).toHaveBeenCalledWith(
      'runtime.tasks.agent_steer',
      expect.objectContaining({
        address: expect.objectContaining({ deviceId: 'build-01' }),
        agentId: 'agent-target',
        clientMessageId: 'client-1',
      })
    )
    const subagentOutputPath = '/srv/project/.kcoder/subagents/agent-target/output.md'
    await services.runtimeWorkApi?.readSubagentArtifact({
      address: remoteAddress,
      path: subagentOutputPath,
      kind: 'output',
    })
    expect(request).toHaveBeenCalledWith(
      'runtime.tasks.agent_artifact_read',
      expect.objectContaining({
        taskId: 'remote-task',
        address: expect.objectContaining({ deviceId: 'build-01' }),
        path: subagentOutputPath,
        kind: 'output',
      })
    )

    const selectedRemoteServices = createLocalAppServices({
      ensure: async () => ({
        running: true,
        ready: true,
        deviceId: 'build-01',
        runtimeInstanceId: 'kcoder-gateway:build-01',
      }),
      request,
      subscribe: async () => () => undefined,
    })
    const selectedRemoteRuntimeWork = await selectedRemoteServices.runtimeWorkApi!.listRuntimeWork()
    expect(selectedRemoteRuntimeWork).toMatchObject({
      projects: [
        { project: { key: 'kcoder:local', stateDeviceId: 'local' } },
        { project: { key: 'kcoder:build-01', stateDeviceId: 'build-01' } },
      ],
    })
    expect(selectedRemoteRuntimeWork.projects.map(item => item.project.id)).toEqual(projectIds)
  })
})
