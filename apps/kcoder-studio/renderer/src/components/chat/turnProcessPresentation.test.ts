import { describe, expect, it } from 'vitest'
import type { ProcessingBlock, WorkbenchMessage } from '@/types/workbench'
import { buildTurnProcessPresentations } from './turnProcessPresentation'

const timestamp = Date.parse('2026-11-20T12:00:00Z')

function assistant(
  id: string,
  blocks: ProcessingBlock[],
  extra: Partial<WorkbenchMessage> = {}
): WorkbenchMessage {
  return {
    id,
    role: 'assistant',
    status: 'done',
    content: '',
    createdAt: new Date(timestamp).toISOString(),
    turnId: 'turn-1',
    attemptId: 'attempt-1',
    blocks,
    ...extra,
  }
}

function thinking(id: string, content = `Thought ${id}`): ProcessingBlock {
  return {
    id,
    subtaskId: 'attempt-1',
    type: 'thinking',
    content,
    status: 'done',
    createdAt: timestamp,
    completedAt: timestamp + 1000,
  }
}

function tool(id: string, toolName: string, status: ProcessingBlock['status'] = 'done'): ProcessingBlock {
  return {
    id,
    subtaskId: 'attempt-1',
    type: 'tool',
    toolName,
    toolInput: {},
    toolOutput: `${id} output`,
    status,
    createdAt: timestamp + 1000,
    completedAt: status === 'done' || status === 'error' ? timestamp + 2000 : undefined,
  }
}

describe('buildTurnProcessPresentations', () => {
  it('groups child stream rows by their confirmed run without inventing Engine attempts', () => {
    const messages = [
      assistant('child-one', [thinking('child-thinking')], { turnId: 'child-one', attemptId: undefined }),
      assistant('child-two', [tool('child-read', 'read')], { turnId: 'child-two', attemptId: undefined }),
    ]
    const groups = buildTurnProcessPresentations(messages, 'child', false, false, 'run-one')
    expect(groups.get('child-one')).toMatchObject({ canUseSummary: true, canCollapse: true })
    expect(groups.get('child-two')?.key).toBe(groups.get('child-one')?.key)
    expect(messages.map(message => [message.turnId, message.attemptId]))
      .toEqual([['child-one', undefined], ['child-two', undefined]])
    expect(buildTurnProcessPresentations(messages, 'child', false, false, 'run-two').get('child-one')?.key)
      .not.toBe(groups.get('child-one')?.key)
    expect(buildTurnProcessPresentations(messages, 'child', false, false).get('child-one')?.canUseSummary)
      .toBe(false)
  })

  it('keeps child steering and genuine attempt boundaries separate within a run', () => {
    const messages = [
      assistant('child-before', [tool('before', 'read')], { attemptId: undefined }),
      { id: 'user-steer', role: 'user' as const, content: 'Follow up', status: 'done' as const, createdAt: '' },
      assistant('child-after', [tool('after', 'read')], { attemptId: undefined }),
      assistant('new-attempt', [tool('real-attempt', 'read')]),
    ]
    const groups = buildTurnProcessPresentations(messages, 'child', false, false, 'run-one')
    expect(groups.get('child-before')?.key).not.toBe(groups.get('child-after')?.key)
    expect(groups.get('new-attempt')?.key).not.toBe(groups.get('child-after')?.key)
    expect(groups.has('user-steer')).toBe(false)
  })

  it('includes the separate final reply in the attempt duration', () => {
    const messages = [
      assistant('process', [tool('duration-read', 'read')], {
        createdAt: String(timestamp / 1000),
      }),
      assistant('final', [], {
        content: 'The final response.',
        completedAt: timestamp + 15000,
      }),
    ]

    expect(buildTurnProcessPresentations(messages, 'duration', false, false).get('process'))
      .toMatchObject({ startedAt: timestamp, completedAt: timestamp + 15000 })
  })

  it('does not invent completion from creation timestamps', () => {
    const message = assistant('missing-completion', [
      { ...tool('no-completion-read', 'read'), completedAt: undefined },
    ])
    const presentation = buildTurnProcessPresentations([message], 'duration', false, false).get(message.id)

    expect(presentation?.status).toBe('completed')
    expect(presentation?.startedAt).toBe(timestamp)
    expect(presentation?.completedAt).toBeUndefined()
  })

  it('groups process messages for the same attempt including ordinary stage replies in the same process range', () => {
    const messages = [
      assistant('step-1', [thinking('thought-1'), tool('read-1', 'read')]),
      assistant('stage-reply', [], { content: 'A visible progress update.' }),
      assistant('step-2', [thinking('thought-2'), tool('command-1', 'bash')], {
        content: 'The final answer remains visible.',
      }),
    ]

    const groups = buildTurnProcessPresentations(messages, 'conversation-1', false, false)
    const first = groups.get('step-1')
    const second = groups.get('step-2')

    expect(first).toBeDefined()
    expect(second?.key).toBe(first?.key)
    expect(first).toMatchObject({
      ownerMessageId: 'step-1',
      status: 'completed',
      canCollapse: true,
      hasThinking: true,
      hasTools: true,
    })
    expect(groups.get('stage-reply')?.key).toBe(first?.key)
    expect(first?.finalMessageId).toBe('step-2')
  })

  it('starts a new presentation group after user input and after an attempt changes', () => {
    const beforeInput = assistant('before-input', [tool('read-before', 'read')])
    const userInput: WorkbenchMessage = {
      id: 'steer',
      role: 'user',
      status: 'done',
      content: 'Continue with this constraint.',
      createdAt: new Date(timestamp + 3000).toISOString(),
    }
    const afterInput = assistant('after-input', [tool('read-after', 'read')])
    const retry = assistant('retry', [tool('retry-read', 'read')], {
      attemptId: 'attempt-2',
    })

    const groups = buildTurnProcessPresentations(
      [beforeInput, userInput, afterInput, retry],
      'conversation-1',
      false,
      false
    )

    expect(groups.get('before-input')?.key).not.toBe(groups.get('after-input')?.key)
    expect(groups.get('after-input')?.key).not.toBe(groups.get('retry')?.key)
    expect(groups.get('before-input')?.canCollapse).toBe(true)
    expect(groups.get('after-input')?.canCollapse).toBe(true)
  })

  it('uses compact summaries only for stable ordinary process groups', () => {
    const narrative = assistant('narrative', [
      {
        id: 'narrative-text',
        subtaskId: 'attempt-1',
        type: 'text',
        content: 'I am checking the repository.',
        status: 'done',
      },
      tool('ordinary-tool', 'read'),
    ])
    const missingIdentity = assistant('missing-identity', [tool('unbound-tool', 'read')], {
      turnId: undefined,
      attemptId: undefined,
    })
    const guidance = assistant('guidance', [
      tool('guidance-tool', 'conversation_guidance'),
      tool('guidance-followup', 'read'),
    ])
    const compaction = assistant('compaction', [tool('context-compaction', 'context_compaction')])

    const groups = buildTurnProcessPresentations(
      [narrative, missingIdentity, guidance, compaction],
      'conversation-1',
      false,
      false
    )

    expect(groups.get('narrative')).toMatchObject({ canUseSummary: true, canCollapse: true })
    expect(groups.get('missing-identity')).toMatchObject({
      canUseSummary: false,
      canCollapse: false,
    })
    expect(groups.get('guidance')).toMatchObject({ canUseSummary: false, canCollapse: false })
    expect(groups.get('compaction')).toMatchObject({ canUseSummary: false, canCollapse: false })
  })

  it.each([
    ['failed message', assistant('failed', [tool('failed-tool', 'read')], { status: 'failed' }), 'failed'],
    ['handled tool error', assistant('failed-tool', [tool('tool-error', 'read', 'error')]), 'completed'],
    ['unknown tool', assistant('unknown-tool', [tool('tool-unknown', 'read', 'unknown')]), 'unknown'],
    ['stopped message', assistant('stopped', [thinking('stopped-thought')], { runtimeStatus: 'cancelled' }), 'stopped'],
  ] as const)('allows folding settled %s without hiding its outcome', (_label, message, status) => {
    const group = buildTurnProcessPresentations([message], 'conversation-1', false, false).get(
      message.id
    )

    expect(group).toMatchObject({ status, canCollapse: true })
  })

  it('does not let conversation waiting hide an unknown or pending process state', () => {
    const unknown = assistant('unknown-while-waiting', [tool('unknown-read', 'read', 'unknown')])
    const pending = assistant('pending-while-waiting', [tool('pending-read', 'read')], {
      status: 'pending',
    })

    expect(
      buildTurnProcessPresentations([unknown], 'conversation-1', true, false).get(unknown.id)
    ).toMatchObject({ status: 'unknown', canUseSummary: true })
    expect(
      buildTurnProcessPresentations([pending], 'conversation-1', true, false).get(pending.id)
    ).toMatchObject({ status: 'pending', canUseSummary: false })
  })

  it('keeps the process summary while the status bar owns a pending interaction', () => {
    const message = assistant('question', [thinking('before-question'), {
      ...tool('question-tool', 'request_user_input', 'pending'),
      renderPayload: { kind: 'request_user_input', request_id: 42,
        questions: [{ id: 'details', question: 'Which scope?', options: [] }] },
    }], { status: 'streaming' })

    expect(buildTurnProcessPresentations([message], 'question', true, false).get(message.id))
      .toMatchObject({ status: 'waiting', canUseSummary: true })
  })

  it('does not apply turn folding while waiting or when the advanced process window is enabled', () => {
    const message = assistant('step', [tool('read', 'read')])

    expect(buildTurnProcessPresentations([message], 'conversation-1', true, false).get('step')).toMatchObject({
      status: 'running',
      canCollapse: false,
    })
    expect(buildTurnProcessPresentations([message], 'conversation-1', false, true).get('step'))
      .toMatchObject({ canUseSummary: false, canCollapse: false })
  })

  it('applies conversation waiting state only to the current tail attempt', () => {
    const previousTurn = assistant('previous-turn', [tool('previous-read', 'read')])
    const userMessage: WorkbenchMessage = {
      id: 'new-request',
      role: 'user',
      status: 'done',
      content: 'Start another task.',
      createdAt: new Date(timestamp + 3000).toISOString(),
    }
    const currentTurn = assistant('current-turn', [thinking('current-thought')], {
      turnId: 'turn-2',
      attemptId: 'attempt-2',
      status: 'streaming',
    })

    const groups = buildTurnProcessPresentations(
      [previousTurn, userMessage, currentTurn],
      'conversation-1',
      true,
      false
    )

    expect(groups.get('previous-turn')).toMatchObject({
      status: 'completed',
      canCollapse: true,
    })
    expect(groups.get('current-turn')).toMatchObject({
      status: 'running',
      canUseSummary: true,
      canCollapse: false,
    })
  })
})

describe('terminal process projection', () => {
  it.each([false, true])('closes only matching attempt activity (advanced window %s)', async advanced => {
    const { projectTerminalProcessBlocks } = await import('./turnProcessPresentation')
    const pending = assistant('before-stop', [tool('pending', 'WebFetch', 'pending')])
    const stop = assistant('stop-marker', [], { runtimeStatus: 'cancelled',
      createdAt: new Date(timestamp + 5000).toISOString() })
    const group = buildTurnProcessPresentations([pending, stop], 'stop', false, advanced).get(pending.id)
    expect(projectTerminalProcessBlocks(pending.blocks, group)?.[0]).toMatchObject({
      status: 'unknown', rawStatus: 'result_unrecorded', completedAt: timestamp + 5000,
    })
    expect(pending.blocks?.[0].status).toBe('pending')
    expect(projectTerminalProcessBlocks(pending.blocks, undefined)).toBe(pending.blocks)
  })

  it('keeps other parallel calls active after one tool fails without a terminal event', async () => {
    const { projectTerminalProcessBlocks } = await import('./turnProcessPresentation')
    const message = assistant('parallel', [tool('error', 'read', 'error'), tool('pending', 'WebFetch', 'pending')], { status: 'streaming' })
    const group = buildTurnProcessPresentations([message], 'parallel', true, false).get(message.id)
    expect(group?.status).toBe('running')
    expect(projectTerminalProcessBlocks(message.blocks, group)).toBe(message.blocks)
  })
})
