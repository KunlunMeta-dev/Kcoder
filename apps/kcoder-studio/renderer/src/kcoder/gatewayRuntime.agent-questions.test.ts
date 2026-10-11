import { describe, expect, test, vi } from 'vitest'
import {
  createTestGatewayRuntime,
  FakeGatewayClient,
  localGatewayServer,
} from './gatewayRuntime.test-support'

describe('source question response ownership and ignore protocol', () => {
  test('source mismatch cannot answer another pending question; ignore answers only its own request', async () => {
    const client = new FakeGatewayClient('thread-source-questions')
    const runtime = createTestGatewayRuntime('token', {
      loadServers: async () => [localGatewayServer()],
      createClient: () => client,
    })
    const task = (await runtime.request('runtime.tasks.create', {
      taskId: 'source-questions',
      executionRequest: { prompt: 'work' },
    })) as { taskId: string }
    const source = {
      parentSessionId: 'thread-source-questions',
      agentId: 'actual-child',
      backgroundRun: {
        parentSessionId: 'thread-source-questions',
        agentId: 'actual-child',
        runId: 'run-1',
      },
    }
    for (const id of [44, 45])
      client.dispatchEvent(
        new CustomEvent('request', {
          detail: {
            id,
            method: 'question/request',
            params: {
              threadId: 'thread-source-questions',
              turnId: 'original-turn',
              questionId: `question-${id}`,
              sourceAgent:
                id === 44
                  ? source
                  : {
                      ...source,
                      agentId: 'other-child',
                      backgroundRun: { ...source.backgroundRun, agentId: 'other-child' },
                    },
              questions: [{ id: 'question-1', prompt: 'Choose', options: [] }],
            },
          },
        })
      )
    await vi.waitFor(() => expect(runtime.pendingQuestionByKey.size).toBe(2))
    const wrong = await runtime.request('runtime.tasks.send', {
      taskId: task.taskId,
      requestUserInputResponse: {
        requestId: 44,
        sourceAgent: { ...source, backgroundRun: { ...source.backgroundRun, runId: 'wrong-run' } },
        answers: {},
      },
    })
    expect(wrong).toMatchObject({ accepted: false, code: 'source_agent_conflict' })
    expect(client.responses).toHaveLength(0)
    const ignored = await runtime.request('runtime.tasks.send', {
      taskId: task.taskId,
      requestUserInputResponse: {
        requestId: 44,
        itemId: 'question-44',
        sourceAgent: source,
        answers: {},
        annotations: { ignored: true },
      },
    })
    expect(ignored).toMatchObject({ accepted: true })
    expect(client.responses).toEqual([
      {
        id: 44,
        result: {
          questionId: 'question-44',
          threadId: 'thread-source-questions',
          turnId: 'original-turn',
          answers: {},
          annotations: { ignored: true },
        },
      },
    ])
    expect(runtime.pendingQuestionByKey.get(`${task.taskId}\0${45}`)?.responsePending).not.toBe(
      true
    )
    expect(runtime.activeTurnByTask.has(task.taskId)).toBe(true)
    expect(client.requests.some(value => value.method === 'turn/interrupt')).toBe(false)
  })
})
