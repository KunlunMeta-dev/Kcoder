import {
  createRuntimeTaskStreamHandlers,
  runtimeMessagesToWorkbenchMessages,
} from '@/features/workbench/runtimePaneMessages'
import { createResponseApiStreamState, emitResponseApiEvent } from '@/stream/responseApiStream'
import { reduceWorkbenchMessages } from '@wegent/chat-core'
import { describe, expect, test } from 'vitest'
import fixtures from '../../../shared/generated/examples.web-sources.json'
import { normalizeWebSources, safeWebSourceUrl, formatWebSourceRetrievedAt } from '../../../shared/webSources'

const source = fixtures.WebSourcesToolResultV1.find(value => value.name === 'native-summary')!.value
  .webSources
const binding = {
  threadId: 'thread-1',
  turnId: 'turn-1',
  attemptId: 'attempt-1',
  toolCallId: 'search-1',
}
describe('native source boundary', () => {
  test('accepts three schema-valid attempts and rejects overflow or invented live states', () => {
    const attempts = Array.from({ length: 3 }, () => source.attempts[0])
    expect(normalizeWebSources({ ...source, attempts }, binding)?.attempts).toHaveLength(3)
    expect(normalizeWebSources({ ...source, attempts: [...attempts, attempts[0]] }, binding)).toBeUndefined()
    expect(normalizeWebSources({ ...source, attempts: [{ ...attempts[0], status: 'switching' }] }, binding)).toBeUndefined()
    const legacy = Object.fromEntries(Object.entries(source).filter(([key]) => key !== 'attempts'))
    expect(normalizeWebSources(legacy, binding)?.attempts).toEqual([])
  })
  test('preserves actual provider, attempts, summary status and separate dates', () => {
    const receipt = normalizeWebSources(source, binding)!
    expect(receipt.provider).toBe('exa-public')
    expect(receipt.status).toBe('partial')
    expect(receipt.attempts[0].requestSent).toBe(true)
    expect(receipt.sources[0]).toMatchObject({
      readStatus: 'summary_only',
      publishedAt: '2026-10-30',
      retrievedAt: '2026-10-31T00:00:00Z',
    })
    expect(safeWebSourceUrl('HTTPS://example.com/page')).toBe(true)
    expect(normalizeWebSources(undefined, binding)).toBeUndefined()
    expect(normalizeWebSources(JSON.stringify(source), binding)).toBeUndefined()
  })
  test('rejects foreign identity, unknown version, forged reads, duplicate IDs and unsafe links', () => {
    for (const field of ['threadId', 'turnId', 'attemptId'] as const) {
      expect(
        normalizeWebSources(
          { ...source, identity: { ...source.identity, [field]: 'peer' } },
          binding
        )
      ).toBeUndefined()
    }
    expect(normalizeWebSources({ ...source, toolCallId: 'other-call' }, binding)).toBeUndefined()
    expect(normalizeWebSources({ ...source, schemaVersion: 2 }, binding)).toBeUndefined()
    expect(
      normalizeWebSources(
        { ...source, sources: [{ ...source.sources[0], readStatus: 'verified' }] },
        binding
      )
    ).toBeUndefined()
    expect(
      normalizeWebSources({ ...source, sources: [source.sources[0], source.sources[0]] }, binding)
    ).toBeUndefined()
    for (const url of [
      'javascript:alert(1)',
      'file:///tmp/page',
      'data:text/html,x',
      'https://user:pass@example.com',
      'https://@example.com',
      'https://example.com/\nfoo',
    ]) {
      expect(safeWebSourceUrl(url)).toBe(false)
      expect(
        normalizeWebSources({ ...source, sources: [{ ...source.sources[0], url }] }, binding)
      ).toBeUndefined()
    }
  })
})

test('native sources survive the normal stream adapter, reducer and history projection', () => {
  let messages: ReturnType<typeof reduceWorkbenchMessages> = []
  const handlers = createRuntimeTaskStreamHandlers(
    { taskId: 'task', deviceId: 'local' },
    {
      onMessageAction: action => {
        messages = reduceWorkbenchMessages(messages, action)
      },
    }
  )
  const receipt = normalizeWebSources(source, binding)!
  const context = {
    taskId: 'task',
    deviceId: 'local',
    subtaskId: 'attempt-1',
    turnId: 'turn-1',
    attemptId: 'attempt-1',
  }
  const state = createResponseApiStreamState()
  emitResponseApiEvent(handlers, 'response.created', { ...context, data: {} }, state)
  emitResponseApiEvent(
    handlers,
    'response.output_item.added',
    {
      ...context,
      data: {
        item: { type: 'function_call', call_id: 'search-1', name: 'WebSearch', arguments: '{}' },
      },
    },
    state
  )
  emitResponseApiEvent(
    handlers,
    'response.output_item.done',
    {
      ...context,
      data: {
        item: {
          type: 'function_call',
          call_id: 'search-1',
          name: 'WebSearch',
          status: 'completed',
          output: 'search output',
          webSources: receipt,
        },
      },
    },
    state
  )
  expect(messages[0].blocks?.[0]).toMatchObject({
    type: 'tool',
    status: 'done',
    webSources: receipt,
  })
  const restored = runtimeMessagesToWorkbenchMessages([
    {
      id: 'answer',
      role: 'assistant',
      content: 'Answer',
      subtaskId: 'attempt-1',
      blocks: [
        {
          id: 'search-1',
          type: 'tool',
          tool_name: 'WebSearch',
          status: 'done',
          webSources: receipt,
        },
      ],
    },
  ])
  expect(restored[0].blocks?.[0]).toMatchObject({ type: 'tool', webSources: receipt })
})

test('source observation dates use a compact local display while publication facts stay raw', () => {
  const raw = '2026-10-31T12:34:56.123456789+00:00'
  const display = formatWebSourceRetrievedAt(raw, 'zh-CN')
  expect(display).toContain('2026')
  expect(display).not.toContain('T12:34:56')
  expect(display).not.toContain('123456789')
  expect(formatWebSourceRetrievedAt('unknown date', 'zh-CN')).toBe('unknown date')
  expect(formatWebSourceRetrievedAt('2026-10-31', 'zh-CN')).toBe('2026-10-31')
})
