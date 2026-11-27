import '@/i18n'
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { subscribeSubagentConversation } from '@/api/local/subagentConversation'
import { ToolBlockItem } from '@/components/chat/blocks/ToolBlockItem'
import { ToolPathPreviewConsumer, toolPathPreviews } from '@/kcoder/toolPathPreview'
import { ToolProgressScopeContext } from '@/kcoder/toolsCatalogContext'
import {
  requestLocalExecutor,
  subscribeLocalExecutorEvents,
  type LocalExecutorEvent,
} from '@/host/localExecutor'
import { SubagentWorkspace } from './SubagentWorkspace'
import { useSubagentConversationSource } from './useSubagentConversation'
import { forwardAcceptedNotification } from '@/kcoder/gateway/runtime/notifications'
import type { GatewayRuntimeCore } from '@/kcoder/gateway/runtime/core'
import type { GatewayClient } from '@/kcoder/gatewayRuntimeTypes'

vi.mock('@/host/localExecutor', () => ({
  requestLocalExecutor: vi.fn(),
  subscribeLocalExecutorEvents: vi.fn(),
}))
vi.mock('@/lib/random-id', () => ({ createRandomUuid: () => 'child-progress-subscription' }))
vi.mock('@/kcoder/gatewayServiceBridge', async importOriginal => ({
  ...(await importOriginal<typeof import('@/kcoder/gatewayServiceBridge')>()),
  emitRuntimeEvent: async (_name: string, event: LocalExecutorEvent) => {
    for (const listener of listeners) listener(event)
  },
}))
vi.mock('@/components/chat/composer/ComposerTextarea', () => ({
  ComposerTextarea: () => <textarea data-testid="subagent-workspace-input" readOnly />,
}))

const address = { deviceId: 'progress-target', taskId: 'parent-task', threadId: 'parent-thread' }
const identity = {
  threadId: address.threadId,
  agentId: 'child',
  runId: 'child-run',
  subscriptionId: 'child-progress-subscription',
}
const toolId = 'shared-tool-id'
const api = { subscribeRuntimeSubagentConversation: subscribeSubagentConversation }
const listeners = new Set<(event: LocalExecutorEvent) => void>()
const onReadArtifact = vi.fn()
const sourceClient = {} as GatewayClient
const notificationOwner = {
  threadKey: (serverId: string, threadId: string) => `${serverId}::${threadId}`,
  taskByThread: new Map([[`${address.deviceId}::${address.threadId}`, address.taskId]]),
  clientByTask: new Map([[address.taskId, sourceClient]]),
  agentConversationSubscriptions: new Map([
    [
      identity.subscriptionId,
      {
        serverId: address.deviceId,
        taskId: address.taskId,
        threadId: address.threadId,
        agentId: identity.agentId,
        client: sourceClient,
        assertCurrent: () => {},
      },
    ],
  ]),
} as unknown as GatewayRuntimeCore
let snapshot: Record<string, unknown>
let sequence: number

function initialSnapshot() {
  return {
    ...identity,
    sequence: 1,
    active: true,
    activeAssistantItemId: 'answer',
    messages: [
      {
        id: 'answer',
        role: 'assistant',
        status: 'streaming',
        content: 'Owned child conversation',
        timestampMs: 1770000000000,
        blocks: [],
      },
    ],
  }
}

function ObservedChild() {
  const { handle, summary: conversation } = useSubagentConversationSource(api, address, identity.agentId, true, {
    runId: identity.runId,
  })
  return (
    <SubagentWorkspace
      agent={{
        id: identity.agentId,
        agentId: identity.agentId,
        agentPath: `${address.threadId}:${identity.agentId}`,
        agentName: 'worker',
        status: conversation.active ? 'running' : 'done',
      }}
      runId={identity.runId}
      connected
      conversationSource={handle}
      conversationActive={conversation.active}
      conversationLoading={conversation.loading}
      conversationError={conversation.error}
      conversationKey={conversation.key}
      conversationActivityTaskId={conversation.activityTaskId}
      toolsCatalogTaskId={address.taskId}
      toolsCatalogServerId={address.deviceId}
      canSteer={false}
      onReadArtifact={onReadArtifact}
      onSteer={vi.fn()}
      onClose={vi.fn()}
    />
  )
}

async function observeChild() {
  const view = render(<ObservedChild />)
  await waitFor(() => expect(listeners.size).toBe(1))
  const legacyToggle = screen.queryByTestId('processing-window-toggle')
  if (legacyToggle) {
    expect(legacyToggle).toHaveAttribute('aria-expanded', 'false')
    fireEvent.click(legacyToggle)
  }
  await waitFor(() =>
    expect(screen.getByTestId('subagent-workspace-records')).toHaveTextContent(
      'Owned child conversation'
    )
  )
  return view
}

// Only transport and subscription admission are controlled. Gateway forwarding,
// projection, subscription reconciliation and tool rendering are production code.
async function send(method: string, params: Record<string, unknown>) {
  await act(async () => {
    await forwardAcceptedNotification.call(
      notificationOwner,
      'agent/stream/event',
      {
        ...identity,
        sequence: ++sequence,
        occurredAtMs: 1770000000000 + sequence,
        method,
        params,
      },
      address.deviceId,
      sourceClient
    )
  })
}

async function progress(generatedLines: number, id = toolId) {
  await send('item/event', {
    event: {
      type: 'tool_input_progress',
      id,
      name: 'edit',
      chars: generatedLines * 16,
      lines: { generatedLines, replacedLines: 1 },
    },
  })
}

function counter(container = screen.getByTestId('subagent-workspace-records')) {
  return within(container).queryByTestId('tool-line-progress')
}

async function expectEstimate(value: string) {
  const processToggle = screen.queryByTestId('final-processing-toggle')
  if (processToggle?.getAttribute('aria-expanded') === 'false') fireEvent.click(processToggle)
  for (const batch of screen.queryAllByTestId('process-activity-toggle')) {
    if (batch.getAttribute('aria-expanded') === 'false') fireEvent.click(batch)
  }
  const toggle = screen.queryByTestId('processing-summary-toggle')
  if (toggle?.getAttribute('aria-expanded') === 'false') fireEvent.click(toggle)
  await waitFor(() => expect(counter()).toHaveTextContent(value))
  expect(counter()).toHaveAttribute('data-tool-id', toolId)
  expect(counter()?.title).toMatch(/尚未写入|Not yet written/)
}

beforeEach(() => {
  vi.clearAllMocks()
  localStorage.clear()
  vi.stubGlobal(
    'ResizeObserver',
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    }
  )
  listeners.clear()
  snapshot = initialSnapshot()
  sequence = 1
  vi.mocked(subscribeLocalExecutorEvents).mockImplementation(async handler => {
    listeners.add(handler)
    return () => listeners.delete(handler)
  })
  vi.mocked(requestLocalExecutor).mockImplementation(async (method, params) => {
    if (method === 'runtime.tasks.agent_stream_subscribe')
      return { ...snapshot, subscriptionId: params?.subscriptionId }
    if (method === 'runtime.tasks.agent_stream_unsubscribe') return { unsubscribed: true }
    return null
  })
})

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

describe('observed child tool argument progress', () => {
  test('shows live child reasoning in the ordinary foldable thinking row', async () => {
    await observeChild()
    await send('item/event', {
      itemId: 'answer', event: { type: 'assistant_thinking_delta', id: 'owned-thought', text: 'Check the first result.' },
    })
    const process = await screen.findByTestId('final-processing-toggle')
    if (process.getAttribute('aria-expanded') === 'false') fireEvent.click(process)
    for (const batch of screen.getAllByTestId('process-activity-toggle')) {
      if (batch.getAttribute('aria-expanded') === 'false') fireEvent.click(batch)
    }
    const reasoning = await screen.findByTestId('assistant-thinking-toggle')
    expect(screen.getByTestId('assistant-thinking-spinner')).toBeVisible()
    fireEvent.click(reasoning)
    expect(screen.getByTestId('assistant-thinking-content')).toHaveTextContent('Check the first result.')
    await send('item/event', {
      itemId: 'answer', event: { type: 'assistant_thinking_delta', id: 'owned-thought', text: ' Choose the next tool.' },
    })
    await waitFor(() => expect(screen.getByTestId('assistant-thinking-content')).toHaveTextContent('Check the first result. Choose the next tool.'))
    await send('item/event', {
      itemId: 'answer', event: { type: 'assistant_thinking_completed', id: 'owned-thought' },
    })
    await waitFor(() => expect(screen.queryByTestId('assistant-thinking-spinner')).not.toBeInTheDocument())
    expect(screen.getByTestId('assistant-thinking-toggle')).toBeVisible()
  })

  test('renders the ordinary retry status and failure details for the child run', async () => {
    await observeChild()
    await send('item/event', {
      event: {
        type: 'system_notice', kind: 'provider_retry', request_kind: 'main',
        attempt: 2, max_retries: 5, retry_after_ms: 9000, model: 'owned-child-model',
      },
    })
    const retry = await screen.findByTestId('provider-retry-status')
    expect(retry).toHaveTextContent('2/5')
    fireEvent.click(screen.getByTestId('provider-retry-details-toggle'))
    expect(screen.getByTestId('provider-retry-details')).toHaveTextContent('owned-child-model')
    await send('item/event', {
      event: {
        type: 'error', error: 'owned child failure',
        provider_failure: {
          category: 'authentication_error', recovery_action: 'needs_human',
          retryable: false, resume_safe: false,
        },
      },
    })
    await send('turn/completed', { turn: { id: identity.runId, status: 'failed' } })
    expect(screen.queryByTestId('provider-retry-status')).not.toBeInTheDocument()
    expect(screen.getByText('API 认证失败')).toBeVisible()
  })

  test('keeps the active tool group open when its model message completes', async () => {
    await observeChild()
    await progress(1)
    await expectEstimate('+1-1')
    await send('item/started', {
      item: { id: toolId, type: 'toolCall', name: 'edit', input: { file_path: 'child.txt' } },
    })
    await send('item/completed', { item: { id: 'answer', type: 'agentMessage' } })
    await expectEstimate('+1-1')
    expect(screen.getByTestId('final-processing-toggle')).toHaveAttribute('aria-expanded', 'true')
    await send('item/completed', {
      item: { id: toolId, type: 'toolCall', status: 'completed', output: 'Updated child.txt' },
    })
    await waitFor(() => expect(counter()).not.toBeInTheDocument())
  })
  test('renders raw argument fragments before tool start and retains the estimate on same-ID start', async () => {
    const view = await observeChild()
    await progress(1)
    await expectEstimate('+1-1')
    await progress(2)
    await expectEstimate('+2-1')
    expect(onReadArtifact).not.toHaveBeenCalled()

    await send('item/completed', { item: { id: 'answer', type: 'agentMessage' } })
    await expectEstimate('+2-1')
    await send('item/started', {
      item: {
        id: toolId,
        type: 'toolCall',
        name: 'edit',
        input: { file_path: 'child.txt', old_string: 'old\n', new_string: 'one\ntwo\n' },
      },
    })
    await expectEstimate('+2-1')
    await send('item/completed', {
      item: { id: toolId, type: 'toolCall', status: 'completed', output: 'Updated child.txt' },
    })
    await waitFor(() => expect(counter()).not.toBeInTheDocument())
    view.unmount()
    await waitFor(() => expect(listeners.size).toBe(0))
    expect(requestLocalExecutor).toHaveBeenCalledWith(
      'runtime.tasks.agent_stream_unsubscribe',
      expect.objectContaining({ address, agentId: identity.agentId })
    )
  })

  test('keeps a child estimate isolated from the parent tool with the same ID', async () => {
    const consumer = new ToolPathPreviewConsumer()
    const client = {}
    const release = toolPathPreviews.acquire(address.deviceId, address.taskId)
    const parent = render(
      <ToolProgressScopeContext.Provider value={{ target: address.deviceId, task: address.taskId }}>
        <div data-testid="parent-tool">
          <ToolBlockItem
            block={{
              id: toolId,
              subtaskId: 'parent-attempt',
              type: 'tool',
              toolName: 'edit',
              status: 'generating_arguments',
              createdAt: 1770000000000,
            }}
          />
        </div>
      </ToolProgressScopeContext.Provider>
    )
    try {
      act(() => {
        consumer.handle(
          'turn/started',
          { serverId: 'instance', threadId: address.threadId, turnId: 'parent-turn', sequence: 1 },
          address.deviceId,
          address.taskId,
          client
        )
        consumer.handle(
          'item/event',
          {
            serverId: 'instance',
            threadId: address.threadId,
            turnId: 'parent-turn',
            sequence: 2,
            event: {
              type: 'tool_input_progress',
              id: toolId,
              name: 'edit',
              chars: 1600,
              lines: { generatedLines: 99, replacedLines: 17 },
            },
          },
          address.deviceId,
          address.taskId,
          client
        )
      })
      expect(counter(screen.getByTestId('parent-tool'))).toHaveTextContent('+99-17')
      const child = await observeChild()
      await progress(1)
      await expectEstimate('+1-1')
      await progress(2)
      await expectEstimate('+2-1')
      expect(counter(screen.getByTestId('parent-tool'))).toHaveTextContent('+99-17')
      child.unmount()
      expect(counter(screen.getByTestId('parent-tool'))).toHaveTextContent('+99-17')
    } finally {
      parent.unmount()
      release()
      consumer.dispose()
    }
  })

  test.each(['completed', 'interrupted', 'failed'])(
    'clears the live estimate when the child run is %s',
    async status => {
      await observeChild()
      await progress(1)
      await expectEstimate('+1-1')
      await send('turn/completed', { turn: { id: identity.runId, status } })
      await waitFor(() => expect(counter()).not.toBeInTheDocument())
    }
  )

  test('drops reset estimates and renders only the new attempt progress', async () => {
    await observeChild()
    await progress(1)
    await expectEstimate('+1-1')
    await send('item/event', { event: { type: 'tool_input_reset' } })
    await waitFor(() => expect(counter()).not.toBeInTheDocument())
    await progress(2)
    await expectEstimate('+2-1')
  })

  test('restores a generating snapshot from its authoritative pending events', async () => {
    snapshot = {
      ...initialSnapshot(),
      pendingEvents: [
        {
          type: 'tool_input_progress',
          id: toolId,
          name: 'edit',
          chars: 48,
          lines: { generatedLines: 3, replacedLines: 1 },
        },
      ],
      messages: [
        {
          ...initialSnapshot().messages[0],
          blocks: [
            {
              id: toolId,
              type: 'tool',
              tool_name: 'edit',
              status: 'generating_arguments',
              timestamp: 1770000000000,
              argument_chars: 48,
            },
          ],
        },
      ],
    }
    const first = await observeChild()
    await expectEstimate('+3-1')
    first.unmount()
    await waitFor(() => expect(listeners.size).toBe(0))
    await observeChild()
    await expectEstimate('+3-1')
    await progress(4)
    await expectEstimate('+4-1')
  })
})

vi.mock('@/features/appearance/useConversationPreferences', async importOriginal => {
  const actual = await importOriginal<typeof import('@/features/appearance/useConversationPreferences')>()
  return { ...actual, useConversationPreferences: () => ({
    ...actual.useConversationPreferences(), conversationProcessDisplay: 'three-level-v1',
  }) }
})
