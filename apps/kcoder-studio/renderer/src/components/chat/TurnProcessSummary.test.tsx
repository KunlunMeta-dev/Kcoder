import { createRef } from 'react'
import { act, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { TurnProcessSummary } from './TurnProcessSummary'
import type { TurnProcessPresentation } from './turnProcessPresentation'
import { sampleRuntimeClock } from '@/kcoder/runtimeClock'
import i18n from '@/i18n'

vi.mock('@/kcoder/runtimeClock', () => ({ sampleRuntimeClock: vi.fn() }))
const start = Date.parse('2026-11-21T12:00:00Z')
const process: TurnProcessPresentation = {
  key: 'attempt-a', ownerMessageId: 'a', status: 'running', canUseSummary: true,
  canCollapse: false, hasThinking: true, hasTools: true, startedAt: start,
  blocks: [
    { id: 'thought', subtaskId: 'a', type: 'thinking', content: 'Check', status: 'done', createdAt: start },
    { id: 'tool', subtaskId: 'a', type: 'tool', toolName: 'read', status: 'pending', createdAt: start + 1000 },
  ],
}
const props = { expanded: false, onToggle: vi.fn(), buttonRef: createRef<HTMLButtonElement>() }

afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); vi.clearAllMocks() })

it('shows state before accumulated target time, ticks monotonically, and freezes on a terminal receipt', async () => {
  vi.useFakeTimers()
  vi.setSystemTime('2040-01-01')
  let monotonic = 100
  vi.spyOn(performance, 'now').mockImplementation(() => monotonic)
  vi.mocked(sampleRuntimeClock).mockResolvedValue({ serverTimeMs: start + 45_000, monotonicTimeMs: 100 })
  const view = render(<TurnProcessSummary {...props} presentation={process} serverId="target-a" />)
  await act(async () => {})
  const button = screen.getByTestId('final-processing-toggle')
  expect(button.firstElementChild).toBe(screen.getByTestId('turn-process-heading'))
  expect(screen.getByTestId('turn-process-heading')).toHaveTextContent('处理中45秒')
  expect(screen.getByTestId('turn-process-elapsed')).toHaveTextContent('45秒')
  expect(screen.getByTestId('turn-process-activity')).toHaveTextContent('正在调用工具')
  expect(button).toHaveAccessibleName('处理中 45秒 · 正在调用工具')
  monotonic += 5000
  vi.setSystemTime('2000-01-01')
  act(() => { vi.advanceTimersByTime(5000) })
  expect(screen.getByTestId('turn-process-elapsed')).toHaveTextContent('50秒')
  expect(sampleRuntimeClock).toHaveBeenCalledTimes(1)
  expect(button).toHaveAttribute('aria-expanded', 'false')
  view.rerender(<TurnProcessSummary {...props} serverId="target-a"
    presentation={{ ...process, status: 'completed', canCollapse: true, completedAt: start + 52_000 }} />)
  act(() => { vi.advanceTimersByTime(60_000) })
  expect(screen.getByTestId('turn-process-elapsed')).toHaveTextContent('52秒')
  expect(screen.getByTestId('turn-process-status')).toHaveTextContent('已完成')
  expect(screen.queryByTestId('turn-process-activity')).not.toBeInTheDocument()
  expect(vi.getTimerCount()).toBe(0)
})

it.each(['failed', 'stopped', 'unknown'] as const)('keeps %s time fixed and never opens details automatically', status => {
  render(<TurnProcessSummary {...props} presentation={{ ...process, status, canCollapse: true, completedAt: start + 9000 }} />)
  expect(screen.getByTestId('turn-process-elapsed')).toHaveTextContent('9秒')
  expect(screen.getByTestId('final-processing-toggle')).toHaveAttribute('aria-expanded', 'false')
  expect(sampleRuntimeClock).not.toHaveBeenCalled()
  fireEvent.click(screen.getByTestId('final-processing-toggle'))
  expect(props.onToggle).toHaveBeenCalledTimes(1)
})

it.each([
  [500, '不足 1 秒'], [59_000, '59秒'], [60_000, '1分'], [123_000, '2分3秒'],
  [3_605_000, '1小时5秒'], [86_400_000, '1天'], [183_845_000, '2天3小时4分5秒'],
])('formats a settled turn of %s ms without padding or lost seconds', (milliseconds, duration) => {
  render(<TurnProcessSummary {...props} presentation={{ ...process, status: 'completed', canCollapse: true,
    completedAt: start + milliseconds }} />)
  expect(screen.getByTestId('turn-process-elapsed')).toHaveTextContent(duration)
  expect(screen.getByTestId('final-processing-toggle')).toHaveAccessibleName(`已完成 ${duration}`)
})

it.each([
  ['waiting', '等待操作'], ['failed', '执行失败'], ['stopped', '已中断'], ['unknown', '状态待确认'],
] as const)('keeps %s distinct without manufacturing a missing duration', (status, label) => {
  render(<TurnProcessSummary {...props} presentation={{ ...process, status, canCollapse: status !== 'waiting',
    startedAt: undefined, completedAt: undefined }} />)
  expect(screen.getByTestId('final-processing-toggle')).toHaveAccessibleName(label)
  expect(screen.queryByTestId('turn-process-elapsed')).not.toBeInTheDocument()
  expect(screen.getByTestId('final-processing-toggle')).toHaveAttribute('aria-expanded', 'false')
})

it('localizes the state and every duration unit in English', async () => {
  await i18n.changeLanguage('en')
  try {
    render(<TurnProcessSummary {...props} presentation={{ ...process, status: 'completed', canCollapse: true,
      completedAt: start + 183_845_000 }} />)
    expect(screen.getByTestId('final-processing-toggle')).toHaveAccessibleName('Completed 2d 3h 4m 5s')
  } finally { await i18n.changeLanguage('zh-CN') }
})

it.each([
  ['running', 'Processing'], ['completed', 'Completed'], ['waiting', 'Waiting for action'],
  ['failed', 'Execution failed'], ['stopped', 'Interrupted'], ['unknown', 'Status unconfirmed'],
] as const)('renders the English %s state without Chinese fallback or invented time', async (status, label) => {
  await i18n.changeLanguage('en')
  try {
    render(<TurnProcessSummary {...props} expanded presentation={{ ...process, status,
      canCollapse: status !== 'running' && status !== 'waiting', startedAt: undefined }} />)
    expect(screen.getByTestId('final-processing-toggle')).toHaveAccessibleName(label)
    expect(screen.queryByTestId('turn-process-elapsed')).not.toBeInTheDocument()
  } finally { await i18n.changeLanguage('zh-CN') }
})

it('rejects a late clock sample after the target or attempt changes', async () => {
  let resolve!: (sample: Awaited<ReturnType<typeof sampleRuntimeClock>>) => void
  vi.mocked(sampleRuntimeClock).mockReturnValueOnce(new Promise(done => { resolve = done }))
    .mockResolvedValueOnce(null)
  const view = render(<TurnProcessSummary {...props} serverId="old-target" presentation={process} />)
  view.rerender(<TurnProcessSummary {...props} serverId="new-target" presentation={{ ...process, key: 'new-attempt' }} />)
  await act(async () => { resolve({ serverTimeMs: start + 200_000, monotonicTimeMs: performance.now() }) })
  expect(screen.queryByTestId('turn-process-elapsed')).not.toBeInTheDocument()
  expect(screen.getByTestId('turn-process-status')).toHaveTextContent('处理中')
})

it('resynchronizes when the page resumes without accumulating timers or polling in the background', async () => {
  vi.useFakeTimers()
  vi.mocked(sampleRuntimeClock).mockResolvedValueOnce({ serverTimeMs: start + 10_000, monotonicTimeMs: performance.now() })
    .mockImplementationOnce(async () => ({ serverTimeMs: start + 90_000, monotonicTimeMs: performance.now() }))
  render(<TurnProcessSummary {...props} serverId="target-a" presentation={process} />)
  await act(async () => {})
  expect(screen.getByTestId('turn-process-elapsed')).toHaveTextContent('10秒')
  vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('hidden')
  act(() => { document.dispatchEvent(new Event('visibilitychange')); vi.advanceTimersByTime(60_000) })
  expect(sampleRuntimeClock).toHaveBeenCalledTimes(1)
  vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('visible')
  await act(async () => { document.dispatchEvent(new Event('visibilitychange')) })
  expect(screen.getByTestId('turn-process-elapsed')).toHaveTextContent('1分30秒')
  expect(sampleRuntimeClock).toHaveBeenCalledTimes(2)
  expect(vi.getTimerCount()).toBe(1)
})

it('shows current activity only while folded and switches to another unfinished parallel tool', () => {
  const earlier = { ...process.blocks[1], id: 'earlier', type: 'tool' as const, toolName: 'plugin-one',
    status: 'pending' as const, displayText: { 'zh-CN': '检查项目', en: 'Inspecting project' } }
  const latest = { ...earlier, id: 'latest', createdAt: earlier.createdAt + 1000,
    displayText: { 'zh-CN': '核对结果', en: 'Checking results' } }
  const view = render(<TurnProcessSummary {...props} presentation={{ ...process, blocks: [earlier, latest] }} />)
  expect(screen.getByTestId('turn-process-activity')).toHaveTextContent('核对结果')
  expect(view.container.querySelector('.animate-spin')).not.toBeNull()
  view.rerender(<TurnProcessSummary {...props} presentation={{ ...process, blocks: [earlier, { ...latest, status: 'done' }] }} />)
  expect(screen.getByTestId('turn-process-activity')).toHaveTextContent('检查项目')
  view.rerender(<TurnProcessSummary {...props} presentation={{ ...process, describing: true,
    blocks: [{ ...earlier, status: 'done' }, { ...latest, status: 'done' }] }} />)
  expect(screen.getByTestId('turn-process-activity')).toHaveTextContent('正在描述情况')
  view.rerender(<TurnProcessSummary {...props} expanded presentation={{ ...process, blocks: [earlier] }} />)
  expect(screen.getByTestId('final-processing-toggle')).toHaveAttribute('aria-expanded', 'true')
  expect(screen.queryByTestId('turn-process-activity')).not.toBeInTheDocument()
  expect(view.container.querySelector('.animate-spin')).toBeNull()
})
