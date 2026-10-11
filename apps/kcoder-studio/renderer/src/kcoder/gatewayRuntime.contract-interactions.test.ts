import i18n from '@/i18n'
import { listen } from '@tauri-apps/api/event'
import { clearMocks, mockIPC } from '@tauri-apps/api/mocks'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { FakeGatewayClient } from './gateway/runtime/contractFixture.test-support'
import { KCoderGatewayRuntime as CoreRuntime } from './gatewayRuntime'
import { KCoderGatewayRuntime } from './installGatewayRuntime'

describe.each([
  ['installed', KCoderGatewayRuntime],
  ['shared', CoreRuntime],
] as const)('KCoder gateway interactions (%s)', (_entry, RuntimeConstructor) => {
  const runtimes = new Set<{ dispose(): void; disposeAsync?: () => Promise<void> }>()
  class KCoderGatewayRuntime extends RuntimeConstructor {
    constructor(...args: ConstructorParameters<typeof CoreRuntime>) {
      super(...args)
      runtimes.add(this)
    }
  }
  beforeEach(() => localStorage.clear())
  afterEach(async () => {
    await Promise.all([...runtimes].map(runtime => runtime.disposeAsync?.() ?? runtime.dispose()))
    runtimes.clear()
    clearMocks()
    vi.restoreAllMocks()
  })
  test('projects app-server questions and returns the selected answer on the same turn', async () => {
    mockIPC(() => undefined, { shouldMockEvents: true })
    const received: Array<{ event: string; payload: Record<string, unknown> }> = []
    const unlisten = await listen<{ event: string; payload: Record<string, unknown> }>(
      'local-executor:event',
      event => received.push(event.payload)
    )
    const client = new FakeGatewayClient('thread-1')
    const runtime = new KCoderGatewayRuntime('token', {
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
      result: {
        answers: { 'question-1': { answers: ['SQLite'] } },
        questionId: 'question-1000000',
        threadId: 'thread-1',
        turnId: 'turn-1',
      },
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
    mockIPC(() => undefined, { shouldMockEvents: true })
    const received: Array<{ event: string; payload: Record<string, unknown> }> = []
    const unlisten = await listen<{ event: string; payload: Record<string, unknown> }>(
      'local-executor:event',
      event => received.push(event.payload)
    )
    const client = new FakeGatewayClient('thread-approval')
    const runtime = new KCoderGatewayRuntime('token', {
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
      result: {
        decision: 'accept',
        approvalId: 'approval-1',
        threadId: 'thread-approval',
        turnId: 'turn-approval',
      },
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
      result: {
        decision: 'decline',
        approvalId: 'approval-2',
        threadId: 'thread-approval',
        turnId: 'turn-approval',
      },
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
    expect(client.responses).toContainEqual({
      id: 2_000_007,
      result: {
        decision: 'accept',
        approvalId: 'approval-file-without-root',
        threadId: 'thread-approval',
        turnId: 'turn-approval',
      },
    })

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
      result: {
        decision: 'accept_for_session',
        approvalId: 'approval-permissions',
        threadId: 'thread-approval',
        turnId: 'turn-approval',
      },
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
      expect(client.responses).toContainEqual({
        id,
        result: {
          decision: 'decline',
          approvalId: `approval-${id}`,
          threadId: 'thread-approval',
          turnId: 'turn-approval',
        },
      })
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
              tool_output: i18n.t('approvalUi.timeout'),
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
      result: {
        decision: 'decline',
        approvalId: 'approval-unknown',
        threadId: 'thread-approval',
        turnId: 'turn-approval',
      },
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
})
