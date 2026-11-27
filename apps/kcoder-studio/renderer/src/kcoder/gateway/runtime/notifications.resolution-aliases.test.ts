import { expect, test } from 'vitest'
import { createTestGatewayRuntime, FakeGatewayClient, localGatewayServer } from '../../gatewayRuntime.test-support'

const aliases = [
  { thread_id: 'peer-thread' },
  { thread: { threadId: 'peer-thread' } },
  { thread: { id: 'peer-thread' } },
  { widget: { threadId: 'peer-thread' } },
  { turn: { threadId: 'peer-thread' } },
  { turn_id: 'peer-turn' },
  { turn: { turnId: 'peer-turn' } },
  { turn: { id: 'peer-turn' } },
  { thread_id: '' },
  { thread_id: 7 },
  { thread_id: '\u0085' },
  { thread_id: '\ud800' },
]

async function fixture(kind: 'question' | 'approval') {
  const client = new FakeGatewayClient('original-thread')
  const runtime = createTestGatewayRuntime('token', {
    loadServers: async () => [localGatewayServer()], createClient: () => client,
  })
  const { taskId } = await runtime.request('runtime.tasks.create', {
    executionRequest: { prompt: 'controlled input' },
  }) as { taskId: string }
  const turnId = runtime.activeTurnByTask.get(taskId)!.turnId
  const binding = { threadId: 'original-thread', turnId, appServerEpoch: 'epoch',
    ...(kind === 'question' ? { questionId: 'original-question' } : { approvalId: 'original-approval' }) }
  const requestId = 41
  await runtime.forwardServerRequest(client, { id: requestId, method: `${kind}/request`, params: {
    ...binding, ...(kind === 'question'
      ? { questions: [{ id: 'item', prompt: 'Continue?', options: [] }] }
      : { action: { type: 'command', command: 'echo controlled' } }),
  } }, 'local')
  const key = `${taskId}\0${requestId}`
  const pending = runtime.pendingQuestionByKey.get(key)!
  expect(pending).toBeDefined()
  const terminal = { ...binding, requestId, reason: 'client_response',
    serverId: 'native', sequence: 42, ...(kind === 'approval' ? { decision: 'accept' } : {}) }
  return { runtime, client, key, pending, terminal }
}

for (const kind of ['question', 'approval'] as const) {
  test.each(aliases)(`${kind}: ambiguous terminal %j preserves the original card and corrected replay`, async alias => {
    const f = await fixture(kind)
    try {
      await f.runtime.forwardNotification(`${kind}/resolved`, { ...f.terminal, ...alias }, 'local', f.client)
      expect(f.runtime.pendingQuestionByKey.get(f.key)).toBe(f.pending)
      // The failed binding must not spend the native sequence: the exact
      // corrected receipt still settles the original waiter without a reply.
      await f.runtime.forwardNotification(`${kind}/resolved`, f.terminal, 'local', f.client)
      expect(f.runtime.pendingQuestionByKey.has(f.key)).toBe(false)
      expect(f.client.responses).toEqual([])
    } finally { await f.runtime.disposeAsync() }
  })

  for (const nullable of [false, true]) {
    test(`${kind}: matching aliases and optional null aliases remain compatible (null=${nullable})`, async () => {
      const f = await fixture(kind)
      try {
        const thread = nullable ? null : f.terminal.threadId
        const turn = nullable ? null : f.terminal.turnId
        await f.runtime.forwardNotification(`${kind}/resolved`, { ...f.terminal,
          thread_id: thread, thread: { threadId: thread, id: thread }, widget: { threadId: thread },
          turn_id: turn, turn: { threadId: thread, turnId: turn, id: turn, status: 'running' },
        }, 'local', f.client)
        expect(f.runtime.pendingQuestionByKey.has(f.key)).toBe(false)
      } finally { await f.runtime.disposeAsync() }
    })
  }
}
