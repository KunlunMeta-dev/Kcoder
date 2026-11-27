import { act, cleanup, fireEvent, render, renderHook, screen, within } from '@testing-library/react'
import { Profiler } from 'react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import i18n from '@/i18n'
import { defaultAppPreferences, type ConversationProcessDisplay } from '@/host/appPreferences'
import type { WorkbenchMessage } from '@/types/workbench'
import { sampleRuntimeClock } from '@/kcoder/runtimeClock'
import { MessageList } from './MessageList'
import { clearPersistentProcessingExpansions, usePersistentProcessingExpansion } from './blocks/processingExpansionState'

const preference = vi.hoisted(() => ({ mode: 'two-level-v1' as ConversationProcessDisplay }))
vi.mock('@/features/appearance/useConversationPreferences', async importOriginal => {
  const actual = await importOriginal<typeof import('@/features/appearance/useConversationPreferences')>()
  return { ...actual, useConversationPreferences: () => ({
    ...defaultAppPreferences, conversationProcessDisplay: preference.mode, hydration: 'ready', saveError: false,
  }) }
})
vi.mock('@/kcoder/runtimeClock', () => ({ sampleRuntimeClock: vi.fn() }))
const start = Date.parse('2026-11-22T10:00:00Z')
function response(): WorkbenchMessage {
  return { id: 'response', role: 'assistant', turnId: 'turn', attemptId: 'attempt',
    status: 'streaming', content: 'I am checking the result.', createdAt: new Date(start).toISOString(),
    blocks: [
      { id: 'thought', type: 'thinking', content: 'Private reasoning', status: 'done', createdAt: start, completedAt: start + 500 },
      { id: 'first', type: 'tool', toolName: 'first-tool', status: 'pending', createdAt: start + 1000,
        displayText: { 'zh-CN': '检查第一个工具', en: 'Checking the first tool' }, toolOutput: 'First output' },
      { id: 'narrative', type: 'text', content: 'The first stage is ready.', status: 'done', createdAt: start + 2000 },
      { id: 'second', type: 'tool', toolName: 'second-tool', status: 'pending', createdAt: start + 3000,
        displayText: { 'zh-CN': '检查第二个工具', en: 'Checking the second tool' }, toolOutput: 'Second output' },
    ] }
}
function finish(message: WorkbenchMessage): WorkbenchMessage {
  return { ...message, status: 'done', completedAt: new Date(start + 12_000).toISOString(),
    blocks: message.blocks?.map(block => ({ ...block, status: 'done',
      completedAt: block.completedAt ?? (block.id === 'first' || block.id === 'narrative' ? start + 2000 : start + 12_000) })) }
}
beforeEach(() => { preference.mode = 'two-level-v1'; vi.mocked(sampleRuntimeClock).mockReset() })
afterEach(() => { cleanup(); clearPersistentProcessingExpansions(); vi.useRealTimers(); vi.restoreAllMocks() })

it.each(['two-level-v1', 'three-level-v1'] as const)('unrelated process folds do not redraw the %s conversation', async mode => {
  preference.mode = mode
  const commits = vi.fn()
  const foreign = renderHook(() => usePersistentProcessingExpansion('foreign-conversation:tool'))
  const message = finish(response())
  render(<Profiler id="selected-conversation" onRender={commits}>
    <MessageList messages={[message]} conversationKey="selected-conversation" />
  </Profiler>)
  await act(async () => {})
  commits.mockClear()
  act(() => foreign.result.current[1](true))
  expect(commits).not.toHaveBeenCalled()
})

it('keeps ordinary text visible, folds both detail levels and never adds a whole-turn fold on completion', () => {
  const message = response()
  const view = render(<MessageList messages={[message]} conversationKey="two-level" />)
  expect(screen.queryByTestId('final-processing-toggle')).not.toBeInTheDocument()
  expect(screen.getAllByTestId('process-activity-toggle')).toHaveLength(2)
  for (const toggle of screen.getAllByTestId('process-activity-toggle')) expect(toggle).toHaveAttribute('aria-expanded', 'false')
  expect(screen.getByText('The first stage is ready.')).toBeVisible()
  expect(screen.getByText('I am checking the result.')).toBeVisible()
  expect(screen.queryByText('Private reasoning')).not.toBeInTheDocument()
  fireEvent.click(screen.getAllByTestId('process-activity-toggle')[0])
  expect(screen.queryByText('Private reasoning')).not.toBeInTheDocument()
  expect(screen.queryByText('First output')).not.toBeInTheDocument()
  view.rerender(<MessageList messages={[finish(message)]} conversationKey="two-level" />)
  expect(screen.queryByTestId('final-processing-toggle')).not.toBeInTheDocument()
  expect(screen.getAllByTestId('process-activity-toggle')[0]).toHaveAttribute('aria-expanded', 'true')
  expect(screen.getByText('The first stage is ready.')).toBeVisible()
  expect(screen.getByText('I am checking the result.')).toBeVisible()
  expect(screen.getAllByTestId('process-activity-heading')[0]).toHaveTextContent('已执行 2秒')
})

it('separates mode choices, updates mounted content, and retains the three-level terminal auto-fold', () => {
  const message = response()
  const view = render(<MessageList messages={[message]} conversationKey="switch" />)
  fireEvent.click(screen.getAllByTestId('process-activity-toggle')[0])
  preference.mode = 'three-level-v1'
  view.rerender(<MessageList messages={[message]} conversationKey="switch" />)
  expect(screen.getByTestId('final-processing-toggle')).toHaveAttribute('aria-expanded', 'true')
  expect(screen.getAllByTestId('process-activity-toggle')[0]).toHaveAttribute('aria-expanded', 'false')
  fireEvent.click(screen.getByTestId('final-processing-toggle'))
  expect(screen.queryByText('The first stage is ready.')).not.toBeInTheDocument()
  preference.mode = 'two-level-v1'
  view.rerender(<MessageList messages={[message]} conversationKey="switch" />)
  expect(screen.getAllByTestId('process-activity-toggle')[0]).toHaveAttribute('aria-expanded', 'true')
  expect(screen.getByText('The first stage is ready.')).toBeVisible()
  preference.mode = 'three-level-v1'
  view.rerender(<MessageList messages={[finish(message)]} conversationKey="switch" />)
  expect(screen.getByTestId('final-processing-toggle')).toHaveAttribute('aria-expanded', 'false')
  expect(screen.queryByText('The first stage is ready.')).not.toBeInTheDocument()
  expect(screen.getByText('I am checking the result.')).toBeVisible()
})

it('uses independent group wall times with one target sample, freezes ended groups and stops on completion', async () => {
  vi.useFakeTimers()
  vi.setSystemTime('2040-01-01')
  let monotonic = 100
  vi.spyOn(performance, 'now').mockImplementation(() => monotonic)
  vi.mocked(sampleRuntimeClock).mockResolvedValue({ serverTimeMs: start + 8000, monotonicTimeMs: 100 })
  const message = response()
  const view = render(<MessageList messages={[message]} conversationKey="clock" providerRetryTarget="target" />)
  await act(async () => {})
  expect(sampleRuntimeClock).toHaveBeenCalledTimes(1)
  const headings = () => screen.getAllByTestId('process-activity-heading')
  expect(headings()[0]).toHaveTextContent('已执行 8秒')
  expect(headings()[1]).toHaveTextContent('已执行 5秒')
  const firstFinished = { ...message, blocks: message.blocks?.map(block => block.id === 'first'
    ? { ...block, status: 'done' as const, completedAt: start + 2000 } : block) }
  view.rerender(<MessageList messages={[firstFinished]} conversationKey="clock" providerRetryTarget="target" />)
  expect(headings()[0]).toHaveTextContent('已执行 2秒')
  monotonic += 3000
  act(() => vi.advanceTimersByTime(3000))
  expect(headings()[0]).toHaveTextContent('已执行 2秒')
  expect(headings()[1]).toHaveTextContent('已执行 8秒')
  expect(sampleRuntimeClock).toHaveBeenCalledTimes(1)
  view.rerender(<MessageList messages={[finish(firstFinished)]} conversationKey="clock" providerRetryTarget="target" />)
  act(() => vi.advanceTimersByTime(10000))
  expect(headings()[0]).toHaveTextContent('已执行 2秒')
  expect(headings()[1]).toHaveTextContent('已执行 9秒')
})

it('selects the newest unfinished parallel tool without changing tool order', () => {
  const message = response()
  message.blocks = message.blocks?.filter(block => block.type !== 'text')
  const view = render(<MessageList messages={[message]} conversationKey="parallel" />)
  const group = screen.getByTestId('process-activity-toggle')
  expect(group).toHaveAccessibleName('已执行 · 思考 1 · 工具调用 2 · 检查第二个工具')
  view.rerender(<MessageList messages={[{ ...message, blocks: message.blocks?.map(block => block.id === 'second'
    ? { ...block, status: 'done', completedAt: start + 4000 } : block) }]} conversationKey="parallel" />)
  expect(group).toHaveAccessibleName('已执行 · 思考 1 · 工具调用 2 · 检查第一个工具')
  fireEvent.click(group)
  const tools = view.container.querySelectorAll('[data-processing-block-id]')
  expect(tools[0]).toHaveTextContent('first-tool')
  expect(tools[1]).toHaveTextContent('second-tool')
})

it.each(['failed', 'unknown'] as const)('does not unfold on %s, hide progress text or duplicate recovery actions', status => {
  const message = { ...response(), status, error: 'Network diagnostic' }
  render(<MessageList messages={[message]} conversationKey={status} onRetryFailedMessage={vi.fn()} />)
  for (const toggle of screen.getAllByTestId('process-activity-toggle')) expect(toggle).toHaveAttribute('aria-expanded', 'false')
  expect(screen.getByText('The first stage is ready.')).toBeVisible()
  expect(screen.queryByTestId('final-processing-toggle')).not.toBeInTheDocument()
  expect(screen.queryByText('First output')).not.toBeInTheDocument()
})

it('localizes two-level state, time and tool activity in English', async () => {
  await i18n.changeLanguage('en')
  try {
    render(<MessageList messages={[finish(response())]} conversationKey="english" />)
    expect(screen.getAllByTestId('process-activity-toggle')[0]).toHaveAccessibleName('Executed 2s · 1 reasoning step · 1 tool call')
  } finally { await i18n.changeLanguage('zh-CN') }
})

it('does not revive the retired whole-message final fold for legacy messages without stable turn IDs', () => {
  const message = finish(response())
  delete message.turnId
  delete message.attemptId
  render(<MessageList messages={[message]} conversationKey="legacy-two" />)
  expect(screen.queryByTestId('final-processing-toggle')).not.toBeInTheDocument()
  expect(screen.getAllByTestId('process-activity-toggle')).toHaveLength(2)
  expect(screen.getByText('The first stage is ready.')).toBeVisible()
  expect(screen.getByText('I am checking the result.')).toBeVisible()
  expect(screen.getAllByTestId('process-activity-heading')[0]).toHaveTextContent('已执行 2秒')
})

it('uses the selected two-level mode for subagent runs and isolates a replacement run', () => {
  const message = response()
  delete message.turnId
  delete message.attemptId
  const view = render(<MessageList messages={[message]} conversationKey="child" processRunId="run-one" />)
  expect(screen.queryByTestId('final-processing-toggle')).not.toBeInTheDocument()
  fireEvent.click(screen.getAllByTestId('process-activity-toggle')[0])
  view.rerender(<MessageList messages={[finish(message)]} conversationKey="child" processRunId="run-one" />)
  expect(screen.getAllByTestId('process-activity-toggle')[0]).toHaveAttribute('aria-expanded', 'true')
  expect(screen.getByText('The first stage is ready.')).toBeVisible()
  view.rerender(<MessageList messages={[message]} conversationKey="child" processRunId="run-two" />)
  expect(screen.getAllByTestId('process-activity-toggle')[0]).toHaveAttribute('aria-expanded', 'false')
})

it('keeps a pending answer and its draft outside folded two-level tool details', () => {
  const message = response()
  message.blocks = [...message.blocks ?? [], { id: 'question', type: 'tool', toolName: 'AskUserQuestion',
    status: 'pending', createdAt: start + 5000, renderPayload: { kind: 'request_user_input', requestId: 42,
      questions: [{ id: 'destination', question: 'Which destination?', options: [] }] } }]
  render(<MessageList messages={[message]} conversationKey="two-question" />)
  const input = screen.getByTestId('request-user-input-custom-destination')
  fireEvent.change(input, { target: { value: 'Retain this draft' } })
  const group = screen.getAllByTestId('process-activity-toggle').at(-1)!
  fireEvent.click(group)
  fireEvent.click(group)
  expect(screen.getByTestId('request-user-input-custom-destination')).toBe(input)
  expect(input).toHaveValue('Retain this draft')
})

it('keeps failure labels in tool details while the summary retains executed time and counts', () => {
  const message = finish(response())
  message.blocks = message.blocks?.map(block => block.id === 'first' ? { ...block, status: 'error' } : block)
  const view = render(<MessageList messages={[message]} conversationKey="neutral-summary" />)
  const summary = screen.getAllByTestId('process-activity-toggle')[0]
  expect(summary).toHaveAccessibleName('已执行 2秒 · 思考 1 · 工具调用 1')
  expect(summary).not.toHaveTextContent(/失败|已完成|处理中/)
  fireEvent.click(summary)
  const tool = view.container.querySelector<HTMLElement>('[data-processing-block-id="first"]')!
  expect(tool).toHaveTextContent('失败')
  fireEvent.click(within(tool).getByRole('button', { name: '运行失败 first-tool' }))
  expect(screen.getByText('First output')).toBeVisible()
  expect(summary).toHaveAttribute('aria-expanded', 'true')
})
