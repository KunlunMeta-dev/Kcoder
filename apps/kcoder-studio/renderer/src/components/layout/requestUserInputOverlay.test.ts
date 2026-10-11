import { describe, expect, test } from 'vitest'
import {
  applyRequestUserInputResponseToMessages,
  createRequestUserInputAliasTracker,
  isHiddenRequestUserInputBlock,
  isImplementationPlanConfirmationResponse,
  observeRequestUserInputAliases,
  requestUserInputPayloadKey,
  requestUserInputRelatedKeys,
  requestUserInputRelatedKeysForPayloads,
  requestUserInputResponseKey,
} from '@/components/chat/requestUserInputMessages'
import type { WorkbenchMessage } from '@/types/workbench'
import { pendingRequestUserInputPayload } from './requestUserInputOverlay'

describe('pendingRequestUserInputPayload', () => {
  test('detects only explicit implementation plan confirmation responses', () => {
    expect(
      isImplementationPlanConfirmationResponse({
        answers: {
          implement: { answers: ['是的，执行此计划'] },
        },
      })
    ).toBe(true)

    expect(
      isImplementationPlanConfirmationResponse({
        answers: {
          adjustment: { answers: ['先缩小范围'] },
        },
      })
    ).toBe(false)

    expect(isImplementationPlanConfirmationResponse({ answers: {} })).toBe(false)
  })

  test('returns the latest pending request_user_input payload', () => {
    const messages = [
      {
        id: 'assistant-1',
        role: 'assistant',
        content: '',
        status: 'completed',
        blocks: [
          {
            id: 'done',
            type: 'tool',
            toolName: 'request_user_input',
            status: 'done',
            renderPayload: { kind: 'request_user_input', requestId: 1 },
          },
        ],
      },
      {
        id: 'assistant-2',
        role: 'assistant',
        content: '',
        status: 'streaming',
        blocks: [
          {
            id: 'pending',
            type: 'tool',
            toolName: 'request_user_input',
            status: 'pending',
            renderPayload: { kind: 'request_user_input', requestId: 2 },
          },
        ],
      },
    ] as WorkbenchMessage[]

    expect(pendingRequestUserInputPayload(messages)).toEqual({
      kind: 'request_user_input',
      requestId: 2,
    })
  })

  test('ignores non-request_user_input blocks', () => {
    const messages = [
      {
        id: 'assistant-1',
        role: 'assistant',
        content: '',
        status: 'completed',
        blocks: [
          {
            id: 'command',
            type: 'tool',
            toolName: 'shell',
            status: 'pending',
            renderPayload: { kind: 'shell' },
          },
        ],
      },
    ] as WorkbenchMessage[]

    expect(pendingRequestUserInputPayload(messages)).toBeNull()
  })

  test('ignores request_user_input payloads that were already answered locally', () => {
    const messages = [
      {
        id: 'assistant-1',
        role: 'assistant',
        content: '',
        status: 'streaming',
        blocks: [
          {
            id: 'pending',
            type: 'tool',
            toolName: 'request_user_input',
            status: 'pending',
            renderPayload: { kind: 'request_user_input', request_id: 42 },
          },
        ],
      },
    ] as WorkbenchMessage[]

    expect(pendingRequestUserInputPayload(messages, new Set(['request:42']))).toBeNull()
  })

  test('returns done request_user_input payloads without a response after refresh', () => {
    const messages = [
      {
        id: 'assistant-1',
        role: 'assistant',
        content: '',
        status: 'done',
        blocks: [
          {
            id: 'request-1',
            type: 'tool',
            toolName: 'request_user_input',
            status: 'done',
            renderPayload: { kind: 'request_user_input', request_id: 42 },
          },
        ],
      },
    ] as WorkbenchMessage[]

    expect(pendingRequestUserInputPayload(messages)).toEqual({
      kind: 'request_user_input',
      request_id: 42,
    })
  })

  test('ignores request_user_input payloads that already include a response', () => {
    const messages = [
      {
        id: 'assistant-1',
        role: 'assistant',
        content: '',
        status: 'done',
        blocks: [
          {
            id: 'request-1',
            type: 'tool',
            toolName: 'request_user_input',
            status: 'done',
            renderPayload: {
              kind: 'request_user_input',
              request_id: 42,
              response: {
                requestId: 42,
                answers: { goal: { answers: ['工作目标'] } },
              },
            },
          },
        ],
      },
    ] as WorkbenchMessage[]

    expect(pendingRequestUserInputPayload(messages)).toBeNull()
  })

  test('does not create an implementation confirmation from assistant plan markdown', () => {
    const messages = [
      {
        id: 'assistant-plan',
        role: 'assistant',
        content: [
          '# 整理环境计划',
          '',
          '## Summary',
          '整理下载目录。',
          '',
          '## Test Plan',
          '确认结果。',
        ].join('\n'),
        status: 'done',
        createdAt: '2026-06-30T00:00:01.000Z',
      },
    ] as WorkbenchMessage[]

    expect(pendingRequestUserInputPayload(messages)).toBeNull()
  })

  test('creates an implementation confirmation from an explicit assistant plan block', () => {
    const messages = [
      {
        id: 'assistant-plan',
        role: 'assistant',
        content: '',
        status: 'done',
        createdAt: '2026-06-30T00:00:01.000Z',
        blocks: [
          {
            id: 'plan-1',
            subtaskId: 1,
            type: 'plan',
            content: '# 整理环境计划\n\n- 整理下载目录。',
            status: 'done',
            createdAt: Date.parse('2026-06-30T00:00:01.000Z'),
          },
        ],
      },
    ] as WorkbenchMessage[]

    expect(pendingRequestUserInputPayload(messages)).toEqual({
      kind: 'request_user_input',
      itemId: 'implementation-plan:assistant-plan:plan-1',
      questions: [
        {
          id: 'implement',
          question: '执行此计划?',
          options: [{ label: '是的，执行此计划' }],
        },
        {
          id: 'adjustment',
          question: '否，请告知 KCoder Studio 如何调整',
          is_other: true,
        },
      ],
    })
  })

  test('does not create an implementation confirmation from a hidden assistant plan block', () => {
    const messages = [
      {
        id: 'assistant-plan',
        role: 'assistant',
        content: '',
        status: 'done',
        createdAt: '2026-06-30T00:00:01.000Z',
        blocks: [
          {
            id: 'plan-1',
            subtaskId: 1,
            type: 'plan',
            content: '# 整理环境计划',
            status: 'done',
            createdAt: Date.parse('2026-06-30T00:00:01.000Z'),
          },
        ],
      },
    ] as WorkbenchMessage[]

    expect(
      pendingRequestUserInputPayload(
        messages,
        new Set(['item:implementation-plan:assistant-plan:plan-1'])
      )
    ).toBeNull()
  })

  test('does not create an implementation confirmation after a later user message', () => {
    const messages = [
      {
        id: 'assistant-plan',
        role: 'assistant',
        content: '',
        status: 'done',
        createdAt: '2026-06-30T00:00:01.000Z',
        blocks: [
          {
            id: 'plan-1',
            subtaskId: 1,
            type: 'plan',
            content: '# 整理环境计划',
            status: 'done',
            createdAt: Date.parse('2026-06-30T00:00:01.000Z'),
          },
        ],
      },
      {
        id: 'user-after-plan',
        role: 'user',
        content: '是的，执行此计划',
        status: 'done',
        createdAt: '2026-06-30T00:00:02.000Z',
      },
    ] as WorkbenchMessage[]

    expect(pendingRequestUserInputPayload(messages)).toBeNull()
  })
})

describe('request user input message helpers', () => {
  test('normalizes request ids from payloads and responses', () => {
    expect(requestUserInputPayloadKey({ kind: 'request_user_input', request_id: 42 })).toBe(
      'request:42'
    )
    expect(requestUserInputResponseKey({ requestId: 42, answers: {} })).toBe('request:42')
  })

  test('stores the local answer on the matching assistant request block', () => {
    const assistantMessage = {
      id: 'assistant-request',
      role: 'assistant',
      content: '',
      status: 'streaming',
      createdAt: '2026-06-30T00:00:01.000Z',
      blocks: [
        {
          id: 'request-1',
          type: 'tool',
          toolName: 'request_user_input',
          status: 'pending',
          renderPayload: { kind: 'request_user_input', request_id: 42 },
        },
      ],
    } as WorkbenchMessage

    const nextMessages = applyRequestUserInputResponseToMessages([assistantMessage], {
      requestId: 42,
      answers: {
        direction: { answers: ['随便，我就想看看样式'] },
      },
    })

    expect(nextMessages).toHaveLength(1)
    expect(nextMessages[0].id).toBe('assistant-request')
    expect(nextMessages[0].blocks?.[0]).toMatchObject({
      status: 'done',
      renderPayload: {
        kind: 'request_user_input',
        request_id: 42,
        response: {
          requestId: 42,
          answers: {
            direction: { answers: ['随便，我就想看看样式'] },
          },
        },
      },
    })
  })

  test('matches a transcript item id after the live request id is rebased away', () => {
    const questions = [
      {
        id: 'question-1',
        header: 'Choice',
        question: 'Choose ALPHA or BETA',
        options: [{ label: 'ALPHA' }, { label: 'BETA' }],
      },
    ]
    const transcriptBlock = {
      id: 'question-e2e-request',
      type: 'tool',
      toolName: 'AskUserQuestion',
      status: 'pending',
      renderPayload: {
        kind: 'request_user_input',
        itemId: 'question-e2e-request',
        questions,
      },
    } as const
    const liveBlock = {
      ...transcriptBlock,
      id: 'request-user-input-1000000',
      renderPayload: {
        kind: 'request_user_input',
        requestId: 1000000,
        itemId: 'question-1000000',
        questions: questions.map(question => ({ ...question, isOther: true, multiSelect: false })),
      },
    } as const
    const response = {
      requestId: 1000000,
      itemId: 'question-1000000',
      answers: { choice: { answers: ['BETA'] } },
    }

    expect(isHiddenRequestUserInputBlock(transcriptBlock, new Set(['request:1000000']))).toBe(false)
    expect(
      isHiddenRequestUserInputBlock(transcriptBlock, new Set(['item:question-e2e-request']))
    ).toBe(true)

    const messages = [
      {
        id: 'assistant-request',
        role: 'assistant',
        content: '',
        status: 'done',
        createdAt: '2026-06-30T00:00:01.000Z',
        blocks: [transcriptBlock, liveBlock],
      } as WorkbenchMessage,
    ]
    expect(requestUserInputRelatedKeys(messages, response)).toEqual([
      'request:1000000',
      'item:question-1000000',
    ])
    const tracker = createRequestUserInputAliasTracker()
    observeRequestUserInputAliases(tracker, [transcriptBlock.renderPayload])
    observeRequestUserInputAliases(tracker, [liveBlock.renderPayload])
    expect(
      requestUserInputRelatedKeysForPayloads(
        tracker.previousPayloads,
        response,
        tracker.aliasesByKey
      )
    ).toEqual(['request:1000000', 'item:question-1000000', 'item:question-e2e-request'])
    const next = applyRequestUserInputResponseToMessages(messages, response)
    expect(next[0].blocks?.[0]).toMatchObject({ status: 'pending' })
    expect(next[0].blocks?.[1]).toMatchObject({
      status: 'done',
      renderPayload: { response },
    })
  })

  test('pairs identical concurrent questions one-to-one without answering the sibling request', () => {
    const questions = [{ id: 'same', question: 'Same question', options: [{ label: 'YES' }] }]
    const transcriptPayloads = [
      { kind: 'request_user_input', itemId: 'transcript-a', questions },
      { kind: 'request_user_input', itemId: 'transcript-b', questions },
    ]
    const livePayloads = [
      { kind: 'request_user_input', requestId: 1, itemId: 'live-a', questions },
      { kind: 'request_user_input', requestId: 2, itemId: 'live-b', questions },
    ]
    const tracker = createRequestUserInputAliasTracker()
    observeRequestUserInputAliases(tracker, transcriptPayloads)
    observeRequestUserInputAliases(tracker, livePayloads)
    const responseA = { requestId: 1, itemId: 'live-a', answers: { same: { answers: ['YES'] } } }

    const relatedA = requestUserInputRelatedKeysForPayloads(
      tracker.previousPayloads,
      responseA,
      tracker.aliasesByKey
    )
    expect(relatedA).toEqual(['request:1', 'item:live-a', 'item:transcript-a'])
    expect(relatedA).not.toContain('request:2')
    expect(relatedA).not.toContain('item:live-b')
    expect(relatedA).not.toContain('item:transcript-b')

    const message = {
      id: 'assistant-concurrent',
      role: 'assistant',
      content: '',
      status: 'streaming',
      createdAt: '2026-06-30T00:00:01.000Z',
      blocks: livePayloads.map((renderPayload, index) => ({
        id: `live-${index}`,
        type: 'tool',
        toolName: 'AskUserQuestion',
        status: 'pending',
        renderPayload,
      })),
    } as WorkbenchMessage
    const updated = applyRequestUserInputResponseToMessages([message], responseA)
    expect(updated[0].blocks?.[0]).toMatchObject({ status: 'done' })
    expect(updated[0].blocks?.[1]).toMatchObject({ status: 'pending' })
  })

  test('does not alias single-select and multi-select questions with identical text', () => {
    const base = { id: 'same', question: 'Same question', options: [{ label: 'YES' }] }
    const tracker = createRequestUserInputAliasTracker()
    observeRequestUserInputAliases(tracker, [
      {
        kind: 'request_user_input',
        itemId: 'single-transcript',
        questions: [{ ...base, multi_select: false }],
      },
    ])
    observeRequestUserInputAliases(tracker, [
      {
        kind: 'request_user_input',
        requestId: 9,
        itemId: 'multi-live',
        questions: [{ ...base, multiSelect: true }],
      },
    ])

    expect(tracker.aliasesByKey.size).toBe(0)
  })

  test('stores the local answer on a done request block without a response', () => {
    const assistantMessage = {
      id: 'assistant-request',
      role: 'assistant',
      content: '',
      status: 'done',
      createdAt: '2026-06-30T00:00:01.000Z',
      blocks: [
        {
          id: 'request-1',
          type: 'tool',
          toolName: 'request_user_input',
          status: 'done',
          renderPayload: { kind: 'request_user_input', request_id: 42 },
        },
      ],
    } as WorkbenchMessage

    const nextMessages = applyRequestUserInputResponseToMessages([assistantMessage], {
      requestId: 42,
      answers: {
        direction: { answers: ['继续'] },
      },
    })

    expect(nextMessages[0].blocks?.[0]).toMatchObject({
      status: 'done',
      renderPayload: {
        response: {
          requestId: 42,
          answers: {
            direction: { answers: ['继续'] },
          },
        },
      },
    })
  })

  test('keeps messages unchanged when no matching request exists', () => {
    const assistantMessage = {
      id: 'assistant',
      role: 'assistant',
      content: 'done',
      status: 'done',
      createdAt: '2026-06-30T00:00:01.000Z',
    } as WorkbenchMessage

    const nextMessages = applyRequestUserInputResponseToMessages([assistantMessage], {
      requestId: 42,
      answers: {},
    })

    expect(nextMessages).toEqual([assistantMessage])
  })
})
