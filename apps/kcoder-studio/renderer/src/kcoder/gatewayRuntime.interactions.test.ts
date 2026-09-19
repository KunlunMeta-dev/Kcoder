import { listen } from '@tauri-apps/api/event'
import { describe, expect, test } from 'vitest'
import { createTestGatewayRuntime, FakeGatewayClient } from './gatewayRuntime.test-support'
import { KCoderGatewayRuntime as InstalledGatewayRuntime } from './installGatewayRuntime'

describe('KCoder gateway runtime task isolation', () => {
  test.each([
    ['extracted', createTestGatewayRuntime],
    [
      'installed',
      (token: string, options: Parameters<typeof createTestGatewayRuntime>[1]) =>
        new InstalledGatewayRuntime(token, options),
    ],
  ] as const)(
    'routes pin mutations through the resident thread owner (%s)',
    async (_name, createRuntime) => {
      const clients: FakeGatewayClient[] = []
      const runtime = createRuntime('token', {
        loadServers: async () => [
          {
            id: 'local',
            label: 'Local',
            description: 'Local',
            transport: 'local',
            workspacePath: '/workspace',
          },
          {
            id: 'peer',
            label: 'Peer',
            description: 'Peer',
            transport: 'local',
            workspacePath: '/peer',
          },
        ],
        createClient: () => {
          const client = new FakeGatewayClient(
            clients.length === 0 ? 'pin-owned-thread' : 'command-client'
          )
          clients.push(client)
          return client
        },
      })
      try {
        await runtime.request('runtime.tasks.create', {
          taskId: 'pin-draft',
          executionRequest: { prompt: 'start' },
        })
        const params = { deviceId: 'local', threadId: 'pin-owned-thread', pinned: true }
        await runtime.request('runtime.sidebar.tasks.pin', params)
        expect(clients[0].requests).toContainEqual({ method: 'runtime.sidebar.tasks.pin', params })
        expect(
          clients
            .slice(1)
            .flatMap(client => client.requests)
            .filter(request => request.method === 'runtime.sidebar.tasks.pin')
        ).toEqual([])
        const peerParams = { ...params, deviceId: 'peer' }
        await runtime.request('runtime.sidebar.tasks.pin', peerParams)
        expect(
          clients[0].requests.filter(request => request.method === 'runtime.sidebar.tasks.pin')
        ).toEqual([{ method: 'runtime.sidebar.tasks.pin', params }])
        expect(clients.slice(1).flatMap(client => client.requests)).toContainEqual({
          method: 'runtime.sidebar.tasks.pin',
          params: peerParams,
        })
      } finally {
        await runtime.dispose()
      }
    }
  )

  test('forks a completed turn into an independently resumed task', async () => {
    const clients: FakeGatewayClient[] = []
    const runtime = createTestGatewayRuntime('token', {
      loadServers: async () => [
        {
          id: 'local',
          label: '当前虚拟机',
          description: '本机',
          transport: 'local',
          workspacePath: '/workspace',
        },
      ],
      createClient: () => {
        const client = new FakeGatewayClient(clients.length === 0 ? 'thread-1' : 'fork-process')
        clients.push(client)
        return client
      },
    })
    await runtime.request('runtime.tasks.create', {
      taskId: 'source-draft',
      executionRequest: { prompt: 'first turn' },
    })
    clients[0].emitNotification('turn/completed', {
      threadId: 'thread-1',
      turnId: 'thread-1-turn',
      turn: { id: 'thread-1-turn', status: 'completed' },
    })

    await expect(
      runtime.request('runtime.tasks.fork_at_turn', {
        taskId: 'kcoder:local:thread-1',
        source: { deviceId: 'local', taskId: 'kcoder:local:thread-1' },
        target: { deviceId: 'local', workspacePath: '/workspace' },
        lastTurnId: 'turn-1',
        title: 'forked task',
      })
    ).resolves.toEqual({
      success: true,
      accepted: true,
      source: { deviceId: 'local', taskId: 'kcoder:local:thread-1' },
      target: {
        deviceId: 'local',
        taskId: 'kcoder:local:thread-1-fork',
        threadId: 'thread-1-fork',
        workspacePath: '/workspace',
        runtimeHandle: { threadId: 'thread-1-fork' },
      },
      runtime: 'kcoder',
    })
    expect(clients[0].requests).toContainEqual({
      method: 'thread/fork',
      params: {
        threadId: 'thread-1',
        lastTurnId: 'turn-1',
        cwd: '/workspace',
        excludeTurns: true,
      },
    })
    expect(clients[1].requests).toContainEqual({
      method: 'thread/resume',
      params: { threadId: 'thread-1-fork' },
    })
    expect(
      JSON.parse(localStorage.getItem('kcoder-studio:task-metadata-v1') ?? '{}')
    ).toMatchObject({
      'local\u0000thread-1-fork': {
        title: 'forked task',
        parent: {
          taskId: 'kcoder:local:thread-1',
          threadId: 'thread-1',
          lastTurnId: 'turn-1',
        },
      },
    })
  })

  test('deletes a failed fork through the client that owns the resumed fork thread', async () => {
    const source = new FakeGatewayClient('thread-source')
    const forkOwner = new FakeGatewayClient('thread-fork-owner')
    forkOwner.metadataUpdateFailure = new Error('metadata write failed')
    const clients = [source, forkOwner]
    let issuedClients = 0
    const runtime = createTestGatewayRuntime('token', {
      loadServers: async () => [
        {
          id: 'local',
          label: '当前虚拟机',
          description: '本机',
          transport: 'local',
          workspacePath: '/workspace',
        },
      ],
      createClient: () => clients[issuedClients++]!,
    })
    await runtime.request('runtime.tasks.create', {
      taskId: 'source-draft',
      executionRequest: { prompt: 'first turn' },
    })
    source.emitNotification('turn/completed', {
      threadId: 'thread-source',
      turnId: 'thread-source-turn',
      turn: { id: 'thread-source-turn', status: 'completed' },
    })

    await expect(
      runtime.request('runtime.tasks.fork_at_turn', {
        taskId: 'kcoder:local:thread-source',
        lastTurnId: 'turn-1',
        title: 'failed fork',
      })
    ).resolves.toMatchObject({ accepted: false, code: 'fork_failed' })
    expect(forkOwner.requests).toContainEqual({
      method: 'thread/delete',
      params: { threadId: 'thread-source-fork' },
    })
    expect(source.requests.some(request => request.method === 'thread/delete')).toBe(false)
    expect(forkOwner.closed).toBe(true)
  })

  test('deletes a fork through its creator when the new owner cannot resume it', async () => {
    const source = new FakeGatewayClient('thread-source-resume-failure')
    const rejectedOwner = new FakeGatewayClient('thread-rejected-owner')
    rejectedOwner.resumeFailure = new Error('resume failed')
    const clients = [source, rejectedOwner]
    let issuedClients = 0
    const runtime = createTestGatewayRuntime('token', {
      loadServers: async () => [
        {
          id: 'local',
          label: '当前虚拟机',
          description: '本机',
          transport: 'local',
          workspacePath: '/workspace',
        },
      ],
      createClient: () => clients[issuedClients++]!,
    })
    await runtime.request('runtime.tasks.create', {
      taskId: 'source-resume-failure',
      executionRequest: { prompt: 'first turn' },
    })
    source.emitNotification('turn/completed', {
      threadId: 'thread-source-resume-failure',
      turnId: 'thread-source-resume-failure-turn',
      turn: { id: 'thread-source-resume-failure-turn', status: 'completed' },
    })

    await expect(
      runtime.request('runtime.tasks.fork_at_turn', {
        taskId: 'kcoder:local:thread-source-resume-failure',
        lastTurnId: 'turn-1',
        title: 'resume failed fork',
      })
    ).resolves.toMatchObject({ accepted: false, code: 'fork_failed' })
    expect(source.requests).toContainEqual({
      method: 'thread/delete',
      params: { threadId: 'thread-source-resume-failure-fork' },
    })
    expect(rejectedOwner.requests.some(request => request.method === 'thread/delete')).toBe(false)
    expect(rejectedOwner.closed).toBe(true)
  })

  test('requires confirmation before restarting app servers with an active turn', async () => {
    const clients: FakeGatewayClient[] = []
    const runtime = createTestGatewayRuntime('token', {
      loadServers: async () => [
        {
          id: 'local',
          label: '当前虚拟机',
          description: '本机',
          transport: 'local',
          workspacePath: '/workspace',
        },
      ],
      createClient: () => {
        const client = new FakeGatewayClient('thread-1')
        clients.push(client)
        return client
      },
    })
    await runtime.request('runtime.tasks.create', {
      taskId: 'active-draft',
      executionRequest: { prompt: 'still running' },
    })
    await expect(runtime.request('runtime.app_server.restart', { ifIdle: true })).resolves.toEqual({
      restarted: false,
      requiresConfirmation: true,
      activeTaskCount: 1,
    })
    expect(clients[0].closed).toBe(false)
    await expect(runtime.request('runtime.app_server.restart', { force: true })).resolves.toEqual({
      restarted: true,
      requiresConfirmation: false,
      activeTaskCount: 1,
    })
    expect(clients[0].closed).toBe(true)
  })

  test('treats a resident background job as active for an idle-only app-server restart', async () => {
    const client = new FakeGatewayClient('thread-background-restart')
    const runtime = createTestGatewayRuntime('token', {
      loadServers: async () => [
        {
          id: 'local',
          label: '当前虚拟机',
          description: '本机',
          transport: 'local',
          workspacePath: '/workspace',
        },
      ],
      createClient: () => client,
    })
    const created = (await runtime.request('runtime.tasks.create', {
      taskId: 'background-restart',
      executionRequest: { prompt: 'spawn background agent' },
    })) as { taskId: string }
    client.emitNotification('turn/completed', {
      threadId: 'thread-background-restart',
      turnId: 'thread-background-restart-turn',
      turn: { id: 'thread-background-restart-turn', status: 'completed' },
    })
    client.emitNotification('item/started', {
      threadId: 'thread-background-restart',
      turnId: 'thread-background-restart-turn',
      item: { id: 'call-background', type: 'toolCall', name: 'spawn_agent', input: {} },
    })
    client.emitNotification('item/event', {
      threadId: 'thread-background-restart',
      turnId: 'thread-background-restart-turn',
      event: {
        type: 'background_job_associated',
        id: 'job-background',
        tool_call_id: 'call-background',
      },
    })
    await new Promise(resolve => setTimeout(resolve, 0))

    await expect(runtime.request('runtime.app_server.restart', { ifIdle: true })).resolves.toEqual({
      restarted: false,
      requiresConfirmation: true,
      activeTaskCount: 1,
    })
    expect(client.closed).toBe(false)
    expect(created.taskId).toBe('kcoder:local:thread-background-restart')
  })

  test('treats an automatic resident follow-up turn as active for an idle-only restart', async () => {
    const client = new FakeGatewayClient('thread-internal-followup')
    const runtime = createTestGatewayRuntime('token', {
      loadServers: async () => [
        {
          id: 'local',
          label: '当前虚拟机',
          description: '本机',
          transport: 'local',
          workspacePath: '/workspace',
        },
      ],
      createClient: () => client,
    })
    await runtime.request('runtime.tasks.create', {
      taskId: 'internal-followup',
      executionRequest: { prompt: 'spawn background agent' },
    })
    client.emitNotification('turn/completed', {
      threadId: 'thread-internal-followup',
      turnId: 'thread-internal-followup-turn',
      turn: { id: 'thread-internal-followup-turn', status: 'completed' },
    })
    client.emitNotification('turn/started', {
      threadId: 'thread-internal-followup',
      turnId: 'background-followup-1',
      turn: {
        id: 'background-followup-1',
        threadId: 'thread-internal-followup',
        status: 'running',
        internal: true,
      },
    })
    await new Promise(resolve => setTimeout(resolve, 0))

    await expect(runtime.request('runtime.app_server.restart', { ifIdle: true })).resolves.toEqual({
      restarted: false,
      requiresConfirmation: true,
      activeTaskCount: 1,
    })
    expect(client.closed).toBe(false)
  })

  test.each([
    ['extracted', createTestGatewayRuntime],
    [
      'installed',
      (token: string, options: Parameters<typeof createTestGatewayRuntime>[1]) =>
        new InstalledGatewayRuntime(token, options),
    ],
  ] as const)(
    'keeps resident background jobs live across a transient task socket reconnect (%s)',
    async (_name, createRuntime) => {
      const received: Array<{ event: string; payload: Record<string, unknown> }> = []
      const unlisten = await listen<{ event: string; payload: Record<string, unknown> }>(
        'local-executor:event',
        event => received.push(event.payload)
      )
      const first = new FakeGatewayClient('thread-background-reconnect')
      const resumed = new FakeGatewayClient('thread-background-reconnect')
      resumed.agentSummaries = [
        {
          agentId: 'job-reconnect',
          agentName: 'reviewer',
          status: 'running',
          acceptingMessages: true,
          queueDepth: 1,
          headMessageId: 'msg-reconnect',
          headStatus: 'queued',
        },
      ]
      const again = new FakeGatewayClient('thread-background-reconnect')
      const clients = [first, resumed, again]
      let issuedClients = 0
      const runtime = createRuntime('token', {
        loadServers: async () => [
          {
            id: 'local',
            label: '当前虚拟机',
            description: '本机',
            transport: 'local',
            workspacePath: '/workspace',
          },
        ],
        createClient: () => clients[issuedClients++]!,
      })
      await runtime.request('runtime.tasks.create', {
        taskId: 'background-reconnect',
        executionRequest: { prompt: 'spawn background agent' },
      })
      first.emitNotification('turn/completed', {
        threadId: 'thread-background-reconnect',
        turnId: 'thread-background-reconnect-turn',
        turn: { id: 'thread-background-reconnect-turn', status: 'completed' },
      })
      first.emitNotification('item/started', {
        threadId: 'thread-background-reconnect',
        turnId: 'thread-background-reconnect-turn',
        item: { id: 'call-reconnect', type: 'toolCall', name: 'spawn_agent', input: {} },
      })
      first.emitNotification('item/event', {
        threadId: 'thread-background-reconnect',
        turnId: 'thread-background-reconnect-turn',
        event: {
          type: 'background_job_associated',
          id: 'job-reconnect',
          tool_call_id: 'call-reconnect',
        },
      })
      await new Promise(resolve => setTimeout(resolve, 0))
      first.close()
      await expect
        .poll(() => resumed.requests[0])
        .toEqual({
          method: 'thread/resume',
          params: { threadId: 'thread-background-reconnect' },
        })
      expect(
        received.some(
          event =>
            event.event === 'response.subagent.activity' &&
            (event.payload.data as Record<string, unknown>)?.status === 'interrupted'
        )
      ).toBe(false)
      await expect
        .poll(() =>
          received.some(
            event =>
              event.event === 'response.subagent.activity' &&
              (event.payload.data as Record<string, unknown>)?.agent_path === 'job-reconnect' &&
              (event.payload.data as Record<string, unknown>)?.steer_status === 'queued_live' &&
              (event.payload.data as Record<string, unknown>)?.message_id === 'msg-reconnect'
          )
        )
        .toBe(true)

      resumed.emitNotification('item/event', {
        threadId: 'thread-background-reconnect',
        turnId: 'thread-background-reconnect-turn',
        event: {
          type: 'background_job_completed',
          id: 'job-reconnect',
          text: 'done after reconnect',
        },
      })
      await expect
        .poll(() =>
          received.some(
            event =>
              event.event === 'response.subagent.activity' &&
              (event.payload.data as Record<string, unknown>)?.agent_path === 'job-reconnect' &&
              (event.payload.data as Record<string, unknown>)?.status === 'completed'
          )
        )
        .toBe(true)
      expect(received).toContainEqual({
        event: 'response.output_item.done',
        payload: {
          taskId: 'kcoder:local:thread-background-reconnect',
          subtaskId: 'thread-background-reconnect-turn',
          deviceId: 'local',
          data: {
            item: {
              type: 'function_call',
              call_id: 'call-reconnect',
              name: 'spawn_agent',
              status: 'completed',
              output: {
                agent_id: 'job-reconnect',
                status: 'completed',
                output: 'done after reconnect',
              },
            },
          },
        },
      })
      resumed.close()
      await expect.poll(() => again.requests[0]?.method).toBe('thread/resume')
      const reconnects = received.filter(
        event =>
          event.event === 'response.block.created' &&
          (event.payload.data as { block?: { tool_name?: string } })?.block?.tool_name ===
            'runtime_reconnecting'
      )
      expect(reconnects).toHaveLength(2)
      expect(new Set(reconnects.map(event => event.payload.subtaskId)).size).toBe(2)
      for (const event of reconnects) {
        expect(event.payload.subtaskId).toBe(
          (event.payload.data as { block: { id: string } }).block.id
        )
      }
      expect(received.filter(event => event.event === 'response.completed')).toHaveLength(1)
      await runtime.dispose()
      await unlisten()
    }
  )

  test('interrupts resident background jobs when the app-server itself exits', async () => {
    const received: Array<{ event: string; payload: Record<string, unknown> }> = []
    const unlisten = await listen<{ event: string; payload: Record<string, unknown> }>(
      'local-executor:event',
      event => received.push(event.payload)
    )
    const first = new FakeGatewayClient('thread-background-server-exit')
    const resumed = new FakeGatewayClient('thread-background-server-exit')
    const clients = [first, resumed]
    let issuedClients = 0
    const runtime = createTestGatewayRuntime('token', {
      loadServers: async () => [
        {
          id: 'local',
          label: '当前虚拟机',
          description: '本机',
          transport: 'local',
          workspacePath: '/workspace',
        },
      ],
      createClient: () => clients[issuedClients++]!,
    })
    await runtime.request('runtime.tasks.create', {
      taskId: 'background-server-exit',
      executionRequest: { prompt: 'spawn background agent' },
    })
    first.emitNotification('turn/completed', {
      threadId: 'thread-background-server-exit',
      turnId: 'thread-background-server-exit-turn',
      turn: { id: 'thread-background-server-exit-turn', status: 'completed' },
    })
    first.emitNotification('item/started', {
      threadId: 'thread-background-server-exit',
      turnId: 'thread-background-server-exit-turn',
      item: { id: 'call-server-exit', type: 'toolCall', name: 'spawn_agent', input: {} },
    })
    first.emitNotification('item/event', {
      threadId: 'thread-background-server-exit',
      turnId: 'thread-background-server-exit-turn',
      event: {
        type: 'background_job_associated',
        id: 'job-server-exit',
        tool_call_id: 'call-server-exit',
      },
    })
    await new Promise(resolve => setTimeout(resolve, 0))

    first.emitNotification('server/disconnected', {
      reason: 'app-server exited',
    })
    first.close()

    await expect
      .poll(() =>
        received.some(
          event =>
            event.event === 'response.subagent.activity' &&
            (event.payload.data as Record<string, unknown>)?.agent_path === 'job-server-exit' &&
            (event.payload.data as Record<string, unknown>)?.status === 'interrupted'
        )
      )
      .toBe(true)
    await unlisten()
  })

  test('projects app-server questions and returns the selected answer on the same turn', async () => {
    const received: Array<{ event: string; payload: Record<string, unknown> }> = []
    const unlisten = await listen<{ event: string; payload: Record<string, unknown> }>(
      'local-executor:event',
      event => received.push(event.payload)
    )
    const client = new FakeGatewayClient('thread-1')
    const runtime = createTestGatewayRuntime('token', {
      loadServers: async () => [
        {
          id: 'local',
          label: '当前虚拟机',
          description: '本机',
          transport: 'local',
          workspacePath: '/workspace',
        },
      ],
      createClient: () => client,
    })
    await runtime.request('runtime.tasks.create', {
      taskId: 'question-draft',
      executionRequest: { prompt: 'ask me' },
    })
    client.dispatchEvent(
      new CustomEvent('request', {
        detail: {
          id: 1_000_000,
          method: 'question/request',
          params: {
            threadId: 'thread-1',
            turnId: 'turn-1',
            questionId: 'question-1000000',
            questions: [
              {
                id: 'question-1',
                header: 'Database',
                prompt: 'Which database?',
                options: [{ label: 'SQLite', value: 'SQLite', description: 'Keep state local.' }],
                allowsFreeform: true,
              },
            ],
          },
        },
      })
    )
    await new Promise(resolve => setTimeout(resolve, 0))
    expect(received).toContainEqual(
      expect.objectContaining({
        event: 'response.block.created',
        payload: expect.objectContaining({
          taskId: 'kcoder:local:thread-1',
          data: expect.objectContaining({
            block: expect.objectContaining({
              tool_name: 'request_user_input',
              status: 'pending',
            }),
          }),
        }),
      })
    )

    await expect(
      runtime.request('runtime.tasks.send', {
        taskId: 'kcoder:local:thread-1',
        address: { deviceId: 'local', taskId: 'kcoder:local:thread-1' },
        requestUserInputResponse: {
          requestId: 1_000_000,
          itemId: 'question-1000000',
          answers: { 'question-1': { answers: ['SQLite'] } },
        },
      })
    ).resolves.toMatchObject({ accepted: true, taskId: 'kcoder:local:thread-1' })
    expect(client.responses).toContainEqual({
      id: 1_000_000,
      result: { answers: { 'question-1': { answers: ['SQLite'] } } },
    })
    expect(received).not.toContainEqual(
      expect.objectContaining({
        event: 'response.block.updated',
        payload: expect.objectContaining({
          data: expect.objectContaining({
            blockId: 'request-user-input-1000000',
            updates: expect.objectContaining({ status: 'done' }),
          }),
        }),
      })
    )
    await expect(
      runtime.request('runtime.tasks.send', {
        taskId: 'kcoder:local:thread-1',
        requestUserInputResponse: {
          requestId: 1_000_000,
          answers: { 'question-1': { answers: ['SQLite'] } },
        },
      })
    ).resolves.toMatchObject({
      accepted: false,
      code: 'request_user_input_response_pending',
    })
    client.emitNotification('question/resolved', {
      requestId: 1_000_000,
      questionId: 'question-1000000',
      threadId: 'thread-1',
      turnId: 'turn-1',
      reason: 'client_response',
    })
    await new Promise(resolve => setTimeout(resolve, 0))
    expect(received).toContainEqual(
      expect.objectContaining({
        event: 'response.block.updated',
        payload: expect.objectContaining({
          data: expect.objectContaining({
            blockId: 'request-user-input-1000000',
            updates: expect.objectContaining({ status: 'done' }),
          }),
        }),
      })
    )

    client.dispatchEvent(
      new CustomEvent('request', {
        detail: {
          id: 1_000_001,
          method: 'question/request',
          params: {
            threadId: 'thread-1',
            turnId: 'turn-interrupted',
            questionId: 'question-interrupted',
            questions: [{ id: 'question-1', prompt: 'Will this turn stop?', options: [] }],
          },
        },
      })
    )
    await new Promise(resolve => setTimeout(resolve, 0))
    client.emitNotification('turn/completed', {
      threadId: 'thread-1',
      turnId: 'turn-interrupted',
      turn: { id: 'turn-interrupted', status: 'interrupted' },
    })
    await new Promise(resolve => setTimeout(resolve, 0))
    expect(received).toContainEqual(
      expect.objectContaining({
        event: 'response.block.updated',
        payload: expect.objectContaining({
          data: expect.objectContaining({
            blockId: 'request-user-input-1000001',
            updates: expect.objectContaining({
              status: 'error',
              tool_output: expect.stringContaining('未收到服务端确认'),
            }),
          }),
        }),
      })
    )
    await unlisten()
  })

  test('projects app-server approvals and returns an explicit fail-closed decision', async () => {
    const received: Array<{ event: string; payload: Record<string, unknown> }> = []
    const unlisten = await listen<{ event: string; payload: Record<string, unknown> }>(
      'local-executor:event',
      event => received.push(event.payload)
    )
    const client = new FakeGatewayClient('thread-approval')
    const runtime = createTestGatewayRuntime('token', {
      loadServers: async () => [
        {
          id: 'local',
          label: '当前虚拟机',
          description: '本机',
          transport: 'local',
          workspacePath: '/workspace',
        },
      ],
      createClient: () => client,
    })
    await runtime.request('runtime.tasks.create', {
      taskId: 'approval-draft',
      executionRequest: { prompt: 'run a command' },
    })
    client.dispatchEvent(
      new CustomEvent('request', {
        detail: {
          id: 2_000_000,
          method: 'approval/request',
          params: {
            serverId: 'server-1',
            threadId: 'thread-approval',
            turnId: 'turn-approval',
            approvalId: 'approval-1',
            action: { type: 'command', command: 'cargo test --workspace' },
            reason: '运行工作区测试',
          },
        },
      })
    )
    await new Promise(resolve => setTimeout(resolve, 0))
    expect(received).toContainEqual(
      expect.objectContaining({
        event: 'response.block.created',
        payload: expect.objectContaining({
          data: expect.objectContaining({
            block: expect.objectContaining({
              tool_name: 'request_user_input',
              renderPayload: expect.objectContaining({
                itemId: 'approval-1',
                questions: [
                  expect.objectContaining({
                    id: 'approval-1',
                    header: 'Permission request',
                    options: expect.arrayContaining([
                      expect.objectContaining({ label: 'Allow once' }),
                      expect.objectContaining({ label: 'Decline' }),
                    ]),
                  }),
                ],
              }),
            }),
          }),
        }),
      })
    )

    await runtime.request('runtime.tasks.send', {
      taskId: 'kcoder:local:thread-approval',
      requestUserInputResponse: {
        requestId: 2_000_000,
        itemId: 'approval-1',
        answers: { 'approval-1': { answers: ['Allow once'] } },
      },
    })
    expect(client.responses).toContainEqual({
      id: 2_000_000,
      result: { decision: 'accept' },
    })
    expect(received).not.toContainEqual(
      expect.objectContaining({
        event: 'response.block.updated',
        payload: expect.objectContaining({
          data: expect.objectContaining({
            blockId: 'request-user-input-2000000',
            updates: expect.objectContaining({ status: 'done' }),
          }),
        }),
      })
    )
    client.emitNotification('approval/resolved', {
      requestId: 2_000_000,
      approvalId: 'approval-1',
      threadId: 'thread-approval',
      turnId: 'turn-approval',
      decision: 'accept',
      reason: 'client_response',
    })
    await new Promise(resolve => setTimeout(resolve, 0))
    expect(received).toContainEqual(
      expect.objectContaining({
        event: 'response.block.updated',
        payload: expect.objectContaining({
          data: expect.objectContaining({
            blockId: 'request-user-input-2000000',
            updates: expect.objectContaining({ status: 'done' }),
          }),
        }),
      })
    )

    client.dispatchEvent(
      new CustomEvent('request', {
        detail: {
          id: 2_000_001,
          method: 'approval/request',
          params: {
            threadId: 'thread-approval',
            turnId: 'turn-approval',
            approvalId: 'approval-2',
            action: { type: 'file_change', path: '/workspace/secret.txt' },
            reason: '修改文件',
          },
        },
      })
    )
    await new Promise(resolve => setTimeout(resolve, 0))
    await runtime.request('runtime.tasks.send', {
      taskId: 'kcoder:local:thread-approval',
      requestUserInputResponse: {
        requestId: 2_000_001,
        itemId: 'approval-2',
        answers: {},
      },
    })
    expect(client.responses).toContainEqual({
      id: 2_000_001,
      result: { decision: 'decline' },
    })
    expect(received.flatMap(event => JSON.stringify(event))).not.toContain(
      expect.stringContaining('Always allow for this session')
    )

    client.dispatchEvent(
      new CustomEvent('request', {
        detail: {
          id: 2_000_007,
          method: 'approval/request',
          params: {
            threadId: 'thread-approval',
            turnId: 'turn-approval',
            approvalId: 'approval-file-without-root',
            action: { type: 'file_change', itemId: 'file-item-1' },
            reason: '修改当前工作区文件',
          },
        },
      })
    )
    await new Promise(resolve => setTimeout(resolve, 0))
    expect(client.responses).not.toContainEqual({ id: 2_000_007, result: { decision: 'decline' } })
    await runtime.request('runtime.tasks.send', {
      taskId: 'kcoder:local:thread-approval',
      requestUserInputResponse: {
        requestId: 2_000_007,
        answers: { 'approval-file-without-root': { answers: ['Allow once'] } },
      },
    })
    expect(client.responses).toContainEqual({ id: 2_000_007, result: { decision: 'accept' } })

    client.dispatchEvent(
      new CustomEvent('request', {
        detail: {
          id: 2_000_008,
          method: 'approval/request',
          params: {
            threadId: 'thread-approval',
            turnId: 'turn-approval',
            approvalId: 'approval-permissions',
            availableDecisions: ['accept', 'acceptForSession', 'decline'],
            action: {
              type: 'permission',
              cwd: '/workspace',
              permissions: { network: { enabled: true } },
            },
          },
        },
      })
    )
    await new Promise(resolve => setTimeout(resolve, 0))
    expect(JSON.stringify(received)).toContain('Always allow for this session')
    expect(JSON.stringify(received)).toContain('network')
    await runtime.request('runtime.tasks.send', {
      taskId: 'kcoder:local:thread-approval',
      requestUserInputResponse: {
        requestId: 2_000_008,
        answers: { 'approval-permissions': { answers: ['Always allow for this session'] } },
      },
    })
    expect(client.responses).toContainEqual({
      id: 2_000_008,
      result: { decision: 'accept_for_session' },
    })

    for (const id of [2_000_002, 2_000_003]) {
      client.dispatchEvent(
        new CustomEvent('request', {
          detail: {
            id,
            method: 'approval/request',
            params: {
              threadId: 'thread-approval',
              turnId: 'turn-approval',
              approvalId: `approval-${id}`,
              action: { type: 'command', command: `echo ${id}` },
            },
          },
        })
      )
    }
    await new Promise(resolve => setTimeout(resolve, 0))
    for (const id of [2_000_002, 2_000_003]) {
      await runtime.request('runtime.tasks.send', {
        taskId: 'kcoder:local:thread-approval',
        requestUserInputResponse: {
          requestId: id,
          itemId: `approval-${id}`,
          answers: { [`approval-${id}`]: { answers: ['拒绝'] } },
        },
      })
      expect(client.responses).toContainEqual({ id, result: { decision: 'decline' } })
    }

    client.dispatchEvent(
      new CustomEvent('request', {
        detail: {
          id: 2_000_005,
          method: 'approval/request',
          params: {
            threadId: 'thread-approval',
            turnId: 'turn-approval',
            approvalId: 'approval-timeout',
            action: { type: 'command', command: 'sleep 600' },
          },
        },
      })
    )
    await new Promise(resolve => setTimeout(resolve, 0))
    client.emitNotification('approval/resolved', {
      requestId: 2_000_005,
      approvalId: 'approval-timeout',
      threadId: 'thread-approval',
      turnId: 'turn-approval',
      decision: 'decline',
      reason: 'timeout',
    })
    await new Promise(resolve => setTimeout(resolve, 0))
    expect(received).toContainEqual(
      expect.objectContaining({
        event: 'response.block.updated',
        payload: expect.objectContaining({
          data: expect.objectContaining({
            blockId: 'request-user-input-2000005',
            updates: expect.objectContaining({
              status: 'error',
              tool_output: expect.stringContaining('timed out'),
            }),
          }),
        }),
      })
    )
    await expect(
      runtime.request('runtime.tasks.send', {
        taskId: 'kcoder:local:thread-approval',
        requestUserInputResponse: {
          requestId: 2_000_005,
          itemId: 'approval-timeout',
          answers: { 'approval-timeout': { answers: ['Allow once'] } },
        },
      })
    ).resolves.toMatchObject({ accepted: false, code: 'missing_request_user_input' })

    client.dispatchEvent(
      new CustomEvent('request', {
        detail: {
          id: 2_000_004,
          method: 'approval/request',
          params: {
            threadId: 'thread-approval',
            turnId: 'turn-approval',
            approvalId: 'approval-unknown',
            action: { type: 'unknown', payload: 'cannot review' },
          },
        },
      })
    )
    await new Promise(resolve => setTimeout(resolve, 0))
    expect(client.responses).toContainEqual({
      id: 2_000_004,
      result: { decision: 'decline' },
    })

    client.dispatchEvent(
      new CustomEvent('request', {
        detail: {
          id: 2_000_006,
          method: 'approval/request',
          params: {
            threadId: 'thread-approval',
            turnId: 'turn-approval',
            approvalId: 'approval-send-failure',
            action: { type: 'command', command: 'echo send-failure' },
          },
        },
      })
    )
    await new Promise(resolve => setTimeout(resolve, 0))
    client.respondFailure = new Error('socket closed before send')
    await expect(
      runtime.request('runtime.tasks.send', {
        taskId: 'kcoder:local:thread-approval',
        requestUserInputResponse: {
          requestId: 2_000_006,
          itemId: 'approval-send-failure',
          answers: { 'approval-send-failure': { answers: ['Allow once'] } },
        },
      })
    ).resolves.toMatchObject({
      accepted: false,
      code: 'request_user_input_send_failed',
    })
    expect(received).toContainEqual(
      expect.objectContaining({
        event: 'response.block.updated',
        payload: expect.objectContaining({
          data: expect.objectContaining({
            blockId: 'request-user-input-2000006',
            updates: expect.objectContaining({
              status: 'error',
              tool_output: expect.stringContaining('socket closed before send'),
            }),
          }),
        }),
      })
    )
    await unlisten()
  })

  test('hydrates 32 configured targets without retaining 32 command connections', async () => {
    let active = 0
    let maxActive = 0
    const clients: FakeGatewayClient[] = []
    const servers = Array.from({ length: 32 }, (_, index) => ({
      id: `server-${index}`,
      label: `服务器 ${index}`,
      description: 'SSH',
      transport: 'ssh' as const,
      host: `server-${index}`,
      workspacePath: `/workspace/${index}`,
    }))
    const runtime = createTestGatewayRuntime('token', {
      loadServers: async () => servers,
      createClient: () => {
        const client = new FakeGatewayClient('unused')
        client.threadResumeSupported = true
        client.connect = async () => {
          active += 1
          maxActive = Math.max(maxActive, active)
        }
        client.close = () => {
          if (!client.closed) active -= 1
          client.closed = true
        }
        clients.push(client)
        return client
      },
    })

    await runtime.request('runtime.tasks.list', {})
    expect(clients).toHaveLength(64)
    expect(maxActive).toBe(4)
    expect(active).toBe(0)
    expect(clients.every(client => client.closed)).toBe(true)
  })

  test('keeps same-named turn buffers isolated across task processes', async () => {
    const clients: FakeGatewayClient[] = []
    const received: Array<{ event: string; payload: Record<string, unknown> }> = []
    const unlisten = await listen<{ event: string; payload: Record<string, unknown> }>(
      'local-executor:event',
      event => received.push(event.payload)
    )
    const runtime = createTestGatewayRuntime('token', {
      loadServers: async () => [
        {
          id: 'local',
          label: '当前虚拟机',
          description: '本机',
          transport: 'local',
          workspacePath: '/workspace',
        },
      ],
      createClient: () => {
        const client = new FakeGatewayClient(`thread-${clients.length + 1}`)
        clients.push(client)
        return client
      },
    })
    await runtime.request('runtime.tasks.create', {
      taskId: 'task-a',
      executionRequest: { prompt: 'A' },
    })
    await runtime.request('runtime.tasks.create', {
      taskId: 'task-b',
      executionRequest: { prompt: 'B' },
    })

    clients[0].emitNotification('turn/started', {
      threadId: 'thread-1',
      turnId: 'turn-1',
      turn: { id: 'turn-1' },
    })
    clients[1].emitNotification('turn/started', {
      threadId: 'thread-2',
      turnId: 'turn-1',
      turn: { id: 'turn-1' },
    })
    clients[0].emitNotification('item/delta', {
      threadId: 'thread-1',
      turnId: 'turn-1',
      delta: { text: 'answer-a' },
    })
    clients[0].emitNotification('item/event', {
      threadId: 'thread-1',
      turnId: 'turn-1',
      event: { type: 'assistant_thinking_delta', text: 'checking-a' },
    })
    clients[1].emitNotification('item/delta', {
      threadId: 'thread-2',
      turnId: 'turn-1',
      delta: { text: 'answer-b' },
    })
    clients[0].emitNotification('turn/completed', {
      threadId: 'thread-1',
      turnId: 'turn-1',
      turn: { id: 'turn-1', status: 'completed' },
    })
    clients[1].emitNotification('turn/completed', {
      threadId: 'thread-2',
      turnId: 'turn-1',
      turn: { id: 'turn-1', status: 'completed' },
    })
    await vi.waitFor(() => {
      expect(received.filter(event => event.event === 'response.completed')).toHaveLength(2)
    })
    await unlisten()

    const completed = received
      .filter(event => event.event === 'response.completed')
      .map(event => ({
        taskId: event.payload.taskId,
        value: (event.payload.data as Record<string, unknown>).value,
        turnId: (event.payload.data as Record<string, unknown>).turnId,
      }))
    expect(completed).toEqual(
      expect.arrayContaining([
        { taskId: 'kcoder:local:thread-1', value: 'answer-a', turnId: 'turn-1' },
        { taskId: 'kcoder:local:thread-2', value: 'answer-b', turnId: 'turn-1' },
      ])
    )
    expect(received).toContainEqual({
      event: 'response.reasoning_summary_text.delta',
      payload: {
        taskId: 'kcoder:local:thread-1',
        subtaskId: 'turn-1',
        deviceId: 'local',
        data: { delta: 'checking-a' },
      },
    })
  })

  test('steers one tracked subagent only when the server advertises agent steering', async () => {
    const received: Array<{ event: string; payload: Record<string, unknown> }> = []
    const unlisten = await listen<{ event: string; payload: Record<string, unknown> }>(
      'local-executor:event',
      event => received.push(event.payload)
    )
    const client = new FakeGatewayClient('thread-steer-agent')
    const runtime = createTestGatewayRuntime('token', {
      loadServers: async () => [
        {
          id: 'local',
          label: '当前虚拟机',
          description: '本机',
          transport: 'local',
          workspacePath: '/workspace',
        },
      ],
      createClient: () => client,
    })
    const created = (await runtime.request('runtime.tasks.create', {
      taskId: 'steer-agent-task',
      executionRequest: { prompt: 'delegate work' },
    })) as { taskId: string }

    const result = (await runtime.request('runtime.tasks.agent_steer', {
      taskId: created.taskId,
      agentId: 'agent-target',
      message: 'change only the target',
      clientMessageId: 'client-steer-1',
    })) as Record<string, unknown>

    expect(result).toMatchObject({
      accepted: true,
      queued: true,
      status: 'queued_live',
      agentId: 'agent-target',
      messageId: 'msg-steer-1',
      clientMessageId: 'client-steer-1',
    })
    expect(client.requests).toContainEqual({
      method: 'agent/steer',
      params: {
        threadId: 'thread-steer-agent',
        agentId: 'agent-target',
        message: 'change only the target',
        clientMessageId: 'client-steer-1',
      },
    })

    client.emitNotification('agent/steer/applied', {
      threadId: 'thread-steer-agent',
      turnId: 'turn-steer-agent',
      agentId: 'agent-target',
      messageId: 'msg-steer-1',
      queueDepth: 0,
      appliedAtMs: 42,
      clientMessageId: 'client-steer-1',
    })
    await new Promise(resolve => setTimeout(resolve, 20))
    expect(
      received
        .filter(event => event.event === 'response.subagent.activity')
        .map(event => (event.payload.data as Record<string, unknown>).steer_status)
    ).toEqual(['queued_live', 'applied'])
    expect(JSON.stringify(received)).not.toContain('change only the target')
    await unlisten()
  })

  test('fails closed when the app-server omits agentSteering capability', async () => {
    const client = new FakeGatewayClient('thread-no-steer')
    client.agentSteeringSupported = false
    const runtime = createTestGatewayRuntime('token', {
      loadServers: async () => [
        {
          id: 'local',
          label: '当前虚拟机',
          description: '本机',
          transport: 'local',
          workspacePath: '/workspace',
        },
      ],
      createClient: () => client,
    })
    const created = (await runtime.request('runtime.tasks.create', {
      taskId: 'no-steer-task',
      executionRequest: { prompt: 'delegate work' },
    })) as { taskId: string }

    await expect(
      runtime.request('runtime.tasks.agent_steer', {
        taskId: created.taskId,
        agentId: 'agent-target',
        message: 'must not be sent',
      })
    ).rejects.toThrow('不支持定向调整')
    expect(client.requests.filter(request => request.method === 'agent/steer')).toHaveLength(0)
  })

  test('links background subagent completion back to its original tool block', async () => {
    const received: Array<{ event: string; payload: Record<string, unknown> }> = []
    const unlisten = await listen<{ event: string; payload: Record<string, unknown> }>(
      'local-executor:event',
      event => received.push(event.payload)
    )
    const client = new FakeGatewayClient('thread-background-agent')
    const runtime = createTestGatewayRuntime('token', {
      loadServers: async () => [
        {
          id: 'local',
          label: '当前虚拟机',
          description: '本机',
          transport: 'local',
          workspacePath: '/workspace',
        },
      ],
      createClient: () => client,
    })
    const created = (await runtime.request('runtime.tasks.create', {
      taskId: 'background-agent-task',
      executionRequest: { prompt: 'delegate work' },
    })) as { taskId: string }

    client.emitNotification('item/started', {
      threadId: 'thread-background-agent',
      turnId: 'turn-background-agent',
      item: {
        id: 'call-spawn-1',
        type: 'toolCall',
        name: 'spawn_agent',
        input: { task_name: 'reviewer', run_in_background: true },
      },
    })
    client.emitNotification('item/event', {
      threadId: 'thread-background-agent',
      turnId: 'turn-background-agent',
      event: {
        type: 'background_job_associated',
        id: 'agent-job-1',
        tool_call_id: 'call-spawn-1',
        run_in_background: true,
      },
    })
    client.emitNotification('item/completed', {
      threadId: 'thread-background-agent',
      turnId: 'turn-background-agent',
      item: {
        id: 'call-spawn-1',
        type: 'toolCall',
        name: 'spawn_agent',
        status: 'completed',
        output: '后台子 Agent 已启动',
      },
    })
    await expect
      .poll(
        () =>
          received.filter(event => {
            const data = event.payload.data as Record<string, unknown>
            const item = data?.item as Record<string, unknown> | undefined
            const output = item?.output as Record<string, unknown> | undefined
            return (
              event.event === 'response.output_item.done' &&
              item?.call_id === 'call-spawn-1' &&
              output?.status === 'running'
            )
          }).length
      )
      .toBeGreaterThan(0)
    client.emitNotification('item/event', {
      threadId: 'thread-background-agent',
      turnId: 'turn-background-agent',
      event: {
        type: 'background_job_completed',
        id: 'agent-job-1',
        text: '审查已完成',
        is_error: false,
      },
    })
    await new Promise(resolve => setTimeout(resolve, 20))

    expect(received).toContainEqual({
      event: 'response.output_item.done',
      payload: {
        taskId: created.taskId,
        subtaskId: 'turn-background-agent',
        deviceId: 'local',
        data: {
          item: {
            type: 'function_call',
            call_id: 'call-spawn-1',
            name: 'spawn_agent',
            status: 'completed',
            output: {
              agent_id: 'agent-job-1',
              status: 'completed',
              output: '审查已完成',
            },
          },
        },
      },
    })
    expect(
      received
        .filter(event => event.event === 'response.subagent.activity')
        .map(event => (event.payload.data as Record<string, unknown>).status)
    ).toEqual(['running', 'completed'])
    await unlisten()
  })

  test('interrupts the exact active turn and waits for completion before replacing it', async () => {
    const client = new FakeGatewayClient('thread-1')
    const runtime = createTestGatewayRuntime('token', {
      loadServers: async () => [
        {
          id: 'local',
          label: '当前虚拟机',
          description: '本机',
          transport: 'local',
          workspacePath: '/workspace',
        },
      ],
      createClient: () => client,
    })
    await runtime.request('runtime.tasks.create', {
      taskId: 'task-a',
      executionRequest: { prompt: 'first' },
    })

    client.interruptResult = false
    await expect(
      runtime.request('runtime.tasks.cancel', {
        address: { taskId: 'kcoder:local:thread-1' },
      })
    ).resolves.toMatchObject({ accepted: false, interrupted: false })
    expect(client.requests.at(-1)).toEqual({
      method: 'turn/interrupt',
      params: { threadId: 'thread-1', turnId: 'thread-1-turn' },
    })

    client.interruptResult = true
    const replacement = runtime.request('runtime.tasks.interrupt_and_send', {
      address: { taskId: 'kcoder:local:thread-1' },
      executionRequest: { prompt: 'replacement' },
    })
    await new Promise(resolve => setTimeout(resolve, 10))
    expect(client.requests.at(-1)).toEqual({
      method: 'turn/interrupt',
      params: { threadId: 'thread-1', turnId: 'thread-1-turn' },
    })
    client.emitNotification('turn/completed', {
      threadId: 'thread-1',
      turnId: 'thread-1-turn',
      turn: { id: 'thread-1-turn', status: 'interrupted' },
    })
    await expect(replacement).resolves.toMatchObject({
      accepted: true,
      taskId: 'kcoder:local:thread-1',
    })
    expect(client.requests.at(-1)).toEqual({
      method: 'turn/start',
      params: {
        threadId: 'thread-1',
        input: [{ type: 'text', text: 'replacement' }],
      },
    })
    await expect(runtime.request('runtime.tasks.list', {})).resolves.toMatchObject({
      workspaces: [{ tasks: [{ taskId: 'kcoder:local:thread-1', running: true }] }],
    })
  })

  test('closes and rolls back a client that returns a malformed thread result', async () => {
    const client = new FakeGatewayClient(null)
    const runtime = createTestGatewayRuntime('token', {
      loadServers: async () => [
        {
          id: 'local',
          label: '当前虚拟机',
          description: '本机',
          transport: 'local',
          workspacePath: '/workspace',
        },
      ],
      createClient: () => client,
    })
    await expect(
      runtime.request('runtime.tasks.create', {
        taskId: 'malformed',
        executionRequest: { prompt: 'hello' },
      })
    ).rejects.toThrow('未返回 thread id')
    expect(client.closed).toBe(true)
    await expect(runtime.request('runtime.tasks.list', {})).resolves.toMatchObject({
      workspaces: [{ tasks: [] }],
    })
  })

  test('interrupts the foreground turn but preserves resident background jobs across reconnect', async () => {
    const received: Array<{ event: string; payload: Record<string, unknown> }> = []
    const unlisten = await listen<{ event: string; payload: Record<string, unknown> }>(
      'local-executor:event',
      event => received.push(event.payload)
    )
    const first = new FakeGatewayClient('thread-reconnect')
    const second = new FakeGatewayClient('thread-reconnect')
    const unexpectedThird = new FakeGatewayClient('thread-reconnect')
    let releaseResume: (() => void) | undefined
    second.resumeGate = new Promise<void>(resolve => {
      releaseResume = resolve
    })
    const clients = [first, second, unexpectedThird]
    let issuedClients = 0
    const runtime = createTestGatewayRuntime('token', {
      loadServers: async () => [
        {
          id: 'local',
          label: '当前虚拟机',
          description: '本机',
          transport: 'local',
          workspacePath: '/workspace',
        },
      ],
      createClient: () => clients[issuedClients++]!,
    })
    const created = (await runtime.request('runtime.tasks.create', {
      taskId: 'reconnect-task',
      executionRequest: { prompt: 'first message' },
    })) as { taskId: string }

    first.close()
    await new Promise(resolve => setTimeout(resolve, 0))
    expect(second.requests[0]).toEqual({
      method: 'thread/resume',
      params: { threadId: 'thread-reconnect' },
    })
    expect(received).toContainEqual(
      expect.objectContaining({
        event: 'response.failed',
        payload: expect.objectContaining({
          taskId: created.taskId,
          data: { message: 'KCoder app-server 连接已断开，已停止当前任务' },
        }),
      })
    )
    const sendAfterReconnect = runtime.request('runtime.tasks.send', {
      taskId: created.taskId,
      message: 'after reconnect',
    })
    await new Promise(resolve => setTimeout(resolve, 0))
    expect(issuedClients).toBe(2)
    releaseResume?.()
    await expect(sendAfterReconnect).resolves.toMatchObject({
      accepted: true,
      taskId: created.taskId,
    })
    expect(
      second.requests.filter(request => request.method !== 'runtime.context.get').slice(0, 3)
    ).toEqual([
      { method: 'thread/resume', params: { threadId: 'thread-reconnect' } },
      { method: 'agent/list', params: { threadId: 'thread-reconnect' } },
      {
        method: 'turn/start',
        params: {
          threadId: 'thread-reconnect',
          input: [{ type: 'text', text: 'after reconnect' }],
        },
      },
    ])
    second.emitNotification('turn/completed', {
      threadId: 'thread-reconnect',
      turnId: 'thread-reconnect-turn',
      turn: { id: 'thread-reconnect-turn', status: 'completed' },
    })
    second.emitNotification('item/started', {
      threadId: 'thread-reconnect',
      turnId: 'turn-background',
      item: { id: 'call-background-disconnect', type: 'toolCall', name: 'spawn_agent', input: {} },
    })
    second.emitNotification('item/event', {
      threadId: 'thread-reconnect',
      turnId: 'turn-background',
      event: {
        type: 'background_job_associated',
        id: 'job-background-disconnect',
        tool_call_id: 'call-background-disconnect',
      },
    })
    await new Promise(resolve => setTimeout(resolve, 0))
    second.close()
    await new Promise(resolve => setTimeout(resolve, 0))
    expect(unexpectedThird.requests[0]).toEqual({
      method: 'thread/resume',
      params: { threadId: 'thread-reconnect' },
    })
    expect(
      received.some(
        event =>
          event.event === 'response.subagent.activity' &&
          (event.payload.data as Record<string, unknown>)?.agent_path ===
            'job-background-disconnect' &&
          (event.payload.data as Record<string, unknown>)?.status === 'interrupted'
      )
    ).toBe(false)
    unexpectedThird.emitNotification('item/event', {
      threadId: 'thread-reconnect',
      turnId: 'turn-background',
      event: {
        type: 'background_job_completed',
        id: 'job-background-disconnect',
        text: 'completed after reconnect',
      },
    })
    await expect
      .poll(() =>
        received.some(
          event =>
            event.event === 'response.subagent.activity' &&
            (event.payload.data as Record<string, unknown>)?.agent_path ===
              'job-background-disconnect' &&
            (event.payload.data as Record<string, unknown>)?.status === 'completed'
        )
      )
      .toBe(true)
    await unlisten()
  })

  test('waits for the latest reconnect generation before sending a new turn', async () => {
    const first = new FakeGatewayClient('thread-reconnect-generation')
    const second = new FakeGatewayClient('thread-reconnect-generation')
    const third = new FakeGatewayClient('thread-reconnect-generation')
    let releaseSecondResume: (() => void) | undefined
    let releaseThirdResume: (() => void) | undefined
    second.resumeGate = new Promise<void>(resolve => {
      releaseSecondResume = resolve
    })
    third.resumeGate = new Promise<void>(resolve => {
      releaseThirdResume = resolve
    })
    const clients = [first, second, third]
    let issuedClients = 0
    let closedSecond = false
    const unlisten = await listen<{ event: string; payload: Record<string, unknown> }>(
      'local-executor:event',
      event => {
        const forwarded = event.payload
        const data = forwarded.payload as Record<string, unknown>
        const updates = data?.data as Record<string, unknown> | undefined
        const blockUpdates = updates?.updates as Record<string, unknown> | undefined
        if (
          !closedSecond &&
          forwarded.event === 'response.block.updated' &&
          blockUpdates?.status === 'done'
        ) {
          closedSecond = true
          second.close()
        }
      }
    )
    const runtime = createTestGatewayRuntime('token', {
      loadServers: async () => [
        {
          id: 'local',
          label: '当前虚拟机',
          description: '本机',
          transport: 'local',
          workspacePath: '/workspace',
        },
      ],
      createClient: () => clients[issuedClients++]!,
    })
    const created = (await runtime.request('runtime.tasks.create', {
      taskId: 'reconnect-generation-task',
      executionRequest: { prompt: 'first message' },
    })) as { taskId: string }

    first.close()
    const sendDuringRecovery = runtime.request('runtime.tasks.send', {
      taskId: created.taskId,
      message: 'send only after the latest recovery',
    })
    await expect
      .poll(() => second.requests[0])
      .toEqual({
        method: 'thread/resume',
        params: { threadId: 'thread-reconnect-generation' },
      })
    releaseSecondResume?.()

    await expect
      .poll(() => third.requests[0])
      .toEqual({
        method: 'thread/resume',
        params: { threadId: 'thread-reconnect-generation' },
      })
    expect(second.requests.some(request => request.method === 'turn/start')).toBe(false)

    releaseThirdResume?.()
    await expect(sendDuringRecovery).resolves.toMatchObject({ accepted: true })
    expect(third.requests.at(-1)).toEqual({
      method: 'turn/start',
      params: {
        threadId: 'thread-reconnect-generation',
        input: [{ type: 'text', text: 'send only after the latest recovery' }],
      },
    })
    await unlisten()
  })

  test('uses authoritative background completion after reconnect despite stale history', async () => {
    const received: Array<{ event: string; payload: Record<string, unknown> }> = []
    const unlisten = await listen<{ event: string; payload: Record<string, unknown> }>(
      'local-executor:event',
      event => received.push(event.payload)
    )
    const first = new FakeGatewayClient('thread-stale-background')
    const resumed = new FakeGatewayClient('thread-stale-background')
    const historyReader = new FakeGatewayClient('thread-stale-background')
    historyReader.threadResumeSupported = true
    historyReader.threadMessages = [
      {
        id: 'assistant-stale-background',
        turnId: 'turn-stale-background',
        role: 'assistant',
        content: '',
        blocks: [
          {
            id: 'call-stale-background',
            type: 'tool',
            toolName: 'spawn_agent',
            toolInput: { run_in_background: true },
            toolOutput: { agent_id: 'job-stale-background', status: 'running' },
            status: 'done',
          },
        ],
        timestampMs: 1700000000500,
      },
    ]
    const clients = [first, resumed, historyReader]
    let issuedClients = 0
    const runtime = createTestGatewayRuntime('token', {
      loadServers: async () => [
        {
          id: 'local',
          label: '当前虚拟机',
          description: '本机',
          transport: 'local',
          workspacePath: '/workspace',
        },
      ],
      createClient: () => clients[issuedClients++]!,
    })
    await runtime.request('runtime.tasks.create', {
      taskId: 'stale-background-task',
      executionRequest: { prompt: 'spawn a background agent' },
    })
    first.emitNotification('item/started', {
      threadId: 'thread-stale-background',
      turnId: 'turn-stale-background',
      item: {
        id: 'call-stale-background',
        type: 'toolCall',
        name: 'spawn_agent',
        input: { run_in_background: true },
      },
    })
    first.emitNotification('item/event', {
      threadId: 'thread-stale-background',
      turnId: 'turn-stale-background',
      event: {
        type: 'background_job_associated',
        id: 'job-stale-background',
        tool_call_id: 'call-stale-background',
      },
    })
    await expect
      .poll(() =>
        received.some(
          event =>
            event.event === 'response.subagent.activity' &&
            (event.payload.data as Record<string, unknown>)?.status === 'running'
        )
      )
      .toBe(true)

    first.close()
    await expect
      .poll(() => resumed.requests[0])
      .toEqual({
        method: 'thread/resume',
        params: { threadId: 'thread-stale-background' },
      })
    resumed.emitNotification('item/event', {
      threadId: 'thread-stale-background',
      turnId: 'turn-stale-background',
      event: {
        type: 'background_job_completed',
        id: 'job-stale-background',
        text: 'completed after reconnect',
      },
    })
    await expect
      .poll(() =>
        received.some(
          event =>
            event.event === 'response.subagent.activity' &&
            (event.payload.data as Record<string, unknown>)?.agent_path ===
              'job-stale-background' &&
            (event.payload.data as Record<string, unknown>)?.status === 'completed'
        )
      )
      .toBe(true)
    expect(
      received.some(
        event =>
          event.event === 'response.subagent.activity' &&
          (event.payload.data as Record<string, unknown>)?.agent_path === 'job-stale-background' &&
          (event.payload.data as Record<string, unknown>)?.status === 'interrupted'
      )
    ).toBe(false)
    await runtime.disposeAsync()
    await unlisten()
  })
})
