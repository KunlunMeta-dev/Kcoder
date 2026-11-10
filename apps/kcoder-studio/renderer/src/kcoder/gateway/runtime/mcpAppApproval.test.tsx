import '@/i18n'
import { listen } from '@/lib/runtime-events'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { expect, test, vi } from 'vitest'
import { reduceWorkbenchMessages } from '@wegent/chat-core'
import { KCoderGatewayRuntime } from '../../gatewayRuntime'
import { FakeGatewayClient, localGatewayServer } from '../../gatewayRuntime.test-support'
import { RequestUserInputCard } from '@/components/chat/RequestUserInputCard'
import { requestUserInputResponseKeys } from '@/components/chat/requestUserInputMessages'
import { pendingRequestUserInputPayload } from '@/components/layout/requestUserInputOverlay'
import { createRuntimeTaskStreamHandlers } from '@/features/workbench/runtimePaneMessages'
import { createResponseApiStreamState, emitResponseApiEvent } from '@/stream/responseApiStream'
import type { WorkbenchMessage } from '@/types/workbench'

test.each(['Allow once', 'Decline'])(
  'App %s uses the normal approval card and ends only its independent row',
  async label => {
    let complete!: (value: unknown) => void
    class Client extends FakeGatewayClient {
      override async request<T>(method: string, params: Record<string, unknown> = {}): Promise<T> {
        if (method === 'thread/start') {
          this.requests.push({ method, params })
          return { thread: { id: 'owned-thread', studioWorkMode: 'kworker' } } as T
        }
        if (method === 'mcp/apps/toolCall') {
          this.requests.push({ method, params })
          queueMicrotask(() =>
            this.dispatchEvent(
              new CustomEvent('request', {
                detail: {
                  id: 987,
                  method: 'approval/request',
                  params: {
                    threadId: 'owned-thread',
                    turnId: 'mcp-app-operation-1',
                    approvalId: 'app-approval',
                    action: { type: 'tool', name: 'mcp__owned__refresh', input: { value: 8 } },
                    reason: 'Refresh owned App data',
                    availableDecisions: ['accept', 'decline'],
                  },
                },
              })
            )
          )
          return (await new Promise(resolve => {
            complete = resolve
          })) as T
        }
        return super.request<T>(method, params)
      }
      override respond(id: number, result: unknown) {
        super.respond(id, result)
        queueMicrotask(() => {
          this.emitNotification('approval/resolved', {
            requestId: id,
            threadId: 'owned-thread',
            turnId: 'mcp-app-operation-1',
            approvalId: 'app-approval',
            reason: 'client_response',
            decision: (result as { decision: string }).decision,
          })
          complete({
            operationId: 'operation-1',
            status: label === 'Allow once' ? 'completed' : 'denied',
          })
        })
      }
    }
    const client = new Client('owned-thread')
    const runtime = new KCoderGatewayRuntime('token', {
      loadServers: async () => [localGatewayServer()],
      createClient: () => client,
    })
    let unlisten = () => {}
    try {
      const created = (await runtime.request('runtime.tasks.create', {
        studioWorkMode: 'kworker',
        executionRequest: { prompt: 'ordinary main turn' },
      })) as { taskId: string }
      const address = { deviceId: 'local', taskId: created.taskId }
      let messages = reduceWorkbenchMessages<unknown, unknown>([], {
        type: 'assistant_started',
        taskId: created.taskId,
        subtaskId: 'main-turn',
      }) as WorkbenchMessage[]
      const mainSettled = vi.fn()
      const handlers = createRuntimeTaskStreamHandlers(address, {
        onMessageAction: action => {
          messages = reduceWorkbenchMessages(messages, action)
        },
        onAssistantSettled: mainSettled,
      })
      const stream = createResponseApiStreamState()
      unlisten = await listen<{ event: string; payload: Record<string, unknown> }>(
        'local-executor:event',
        event => emitResponseApiEvent(handlers, event.payload.event, event.payload.payload, stream)
      )
      const operation = runtime.request('runtime.mcpApps.request', {
        address,
        method: 'mcp/apps/toolCall',
        params: {
          widgetId: 'widget',
          revision: 1,
          connectionId: 'original',
          operationId: 'operation-1',
          name: 'refresh',
          arguments: { value: 8 },
        },
      })
      await waitFor(() => expect(pendingRequestUserInputPayload(messages)).not.toBeNull())
      const answered = new Set<string>()
      const payload = pendingRequestUserInputPayload(messages)!
      expect(payload).toMatchObject({ operationOrigin: 'mcp_app' })
      render(
        <RequestUserInputCard
          payload={payload}
          onSubmit={response => {
            requestUserInputResponseKeys(response).forEach(key => answered.add(key))
            void runtime.request('runtime.tasks.send', {
              taskId: created.taskId,
              requestUserInputResponse: response,
            })
          }}
        />
      )
      await userEvent.click(
        screen.getByTestId(
          `request-user-input-option-app-approval-${label === 'Allow once' ? 0 : 1}`
        )
      )
      await operation
      await waitFor(() => expect(pendingRequestUserInputPayload(messages, answered)).toBeNull())
      const appRow = messages.find(message => message.subtaskId === 'mcp-app-operation-1')
      expect(appRow?.status).toBe('done')
      expect(appRow?.blocks?.[0]).toMatchObject({ status: 'done' })
      expect(messages.find(message => message.subtaskId === 'main-turn')?.status).toBe('streaming')
      expect(mainSettled).not.toHaveBeenCalled()
      expect(client.responses.at(-1)).toEqual({
        id: 987,
        result: {
          decision: label === 'Allow once' ? 'accept' : 'decline',
          approvalId: 'app-approval',
          threadId: 'owned-thread',
          turnId: 'mcp-app-operation-1',
        },
      })
    } finally {
      unlisten()
      await runtime.dispose()
    }
  }
)

test('ordinary model approvals attach to the current attempt but keep the logical reply identity', async () => {
  const client = new FakeGatewayClient('normal-thread')
  const runtime = new KCoderGatewayRuntime('token', {
    loadServers: async () => [localGatewayServer()],
    createClient: () => client,
  })
  let unlisten = () => {}
  try {
    const created = (await runtime.request('runtime.tasks.create', {
      executionRequest: { prompt: 'ordinary main turn' },
    })) as { taskId: string }
    const address = { deviceId: 'local', taskId: created.taskId }
    let messages: WorkbenchMessage[] = []
    const handlers = createRuntimeTaskStreamHandlers(address, {
      onMessageAction: action => {
        messages = reduceWorkbenchMessages(messages, action)
      },
    })
    const state = createResponseApiStreamState()
    unlisten = await listen<{ event: string; payload: Record<string, unknown> }>(
      'local-executor:event',
      event => emitResponseApiEvent(handlers, event.payload.event, event.payload.payload, state)
    )
    client.emitNotification('turn/started', {
      threadId: 'normal-thread',
      turnId: 'logical-turn',
      attemptId: 'current-attempt',
      turn: { id: 'logical-turn', status: 'running' },
    })
    await waitFor(() =>
      expect(messages.some(message => message.subtaskId === 'current-attempt')).toBe(true)
    )
    client.dispatchEvent(
      new CustomEvent('request', {
        detail: {
          id: 988,
          method: 'approval/request',
          params: {
            threadId: 'normal-thread',
            turnId: 'logical-turn',
            approvalId: 'normal-approval',
            action: { type: 'tool', name: 'write', input: { path: 'owned.md' } },
            availableDecisions: ['accept', 'decline'],
          },
        },
      })
    )
    await waitFor(() => expect(pendingRequestUserInputPayload(messages)).not.toBeNull())
    expect(messages).toHaveLength(1)
    const payload = pendingRequestUserInputPayload(messages)!
    expect(payload).not.toHaveProperty('operationOrigin')
    render(
      <RequestUserInputCard
        payload={payload}
        onSubmit={response => {
          void runtime.request('runtime.tasks.send', {
            taskId: created.taskId,
            requestUserInputResponse: response,
          })
        }}
      />
    )
    await userEvent.click(screen.getByTestId('request-user-input-option-normal-approval-0'))
    expect(client.responses.at(-1)).toEqual({
      id: 988,
      result: {
        decision: 'accept',
        approvalId: 'normal-approval',
        threadId: 'normal-thread',
        turnId: 'logical-turn',
      },
    })
    client.emitNotification('approval/resolved', {
      requestId: 988,
      approvalId: 'normal-approval',
      threadId: 'normal-thread',
      turnId: 'logical-turn',
      reason: 'client_response',
      decision: 'accept',
    })
    await waitFor(() => expect(messages[0].blocks?.[0].status).toBe('done'))
    expect(messages[0].status).toBe('streaming')
    client.emitNotification('turn/completed', {
      threadId: 'normal-thread',
      turnId: 'logical-turn',
      attemptId: 'current-attempt',
      turn: { id: 'logical-turn', attemptId: 'current-attempt', status: 'completed' },
    })
    await waitFor(() => expect(messages[0].status).toBe('done'))
    expect(messages).toHaveLength(1)
  } finally {
    unlisten()
    await runtime.dispose()
  }
})
