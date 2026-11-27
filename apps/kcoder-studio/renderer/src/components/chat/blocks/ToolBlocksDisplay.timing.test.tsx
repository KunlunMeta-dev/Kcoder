import type { ReactNode } from 'react'
import { act, render, screen } from '@testing-library/react'
import { afterEach, expect, test, vi } from 'vitest'
import { RetainedPage } from '@/components/layout/retainedPages'
import { ToolsCatalogContext } from '@/kcoder/toolsCatalogContext'
import type { ProcessingBlock } from '@/types/workbench'
import { ToolBlocksDisplay } from './ToolBlocksDisplay'
import '@/i18n'

const start = 1_800_000_000_000
const block: ProcessingBlock = { id: 'timed-summary-tool', type: 'tool', toolName: 'owned-summary-operation',
  status: 'streaming', createdAt: start }
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks() })

test('omitting the group summary leaves only concrete tool clocks running', async () => {
  vi.useFakeTimers()
  vi.setSystemTime(start)
  const catalog = new Map(), metadata = vi.spyOn(catalog, 'get')
  const view = render(<ToolsCatalogContext.Provider value={catalog}>
    <ToolBlocksDisplay blocks={[block]} isStreaming startedAt={start} showSummary={false} />
  </ToolsCatalogContext.Provider>)
  await act(async () => {})
  const reads = metadata.mock.calls.length
  expect(screen.queryByTestId('processing-summary-header')).not.toBeInTheDocument()
  act(() => { vi.advanceTimersByTime(1200) })
  expect(screen.getByTestId('tool-block-duration')).toHaveTextContent('1.2s')
  expect(metadata).toHaveBeenCalledTimes(reads)
  view.unmount()
  expect(vi.getTimerCount()).toBe(0)
})

test.each(['retained', 'browser'])('a %s-hidden tool summary stops updating and inspecting unchanged metadata', async hidden => {
  vi.useFakeTimers()
  vi.setSystemTime(start)
  let active = true, visible = true
  vi.spyOn(document, 'visibilityState', 'get').mockImplementation(() => visible ? 'visible' : 'hidden')
  const catalog = new Map(), metadata = vi.spyOn(catalog, 'get')
  const wrapper = ({ children }: { children: ReactNode }) =>
    <ToolsCatalogContext.Provider value={catalog}><RetainedPage open={active}>{children}</RetainedPage></ToolsCatalogContext.Provider>
  const view = render(<ToolBlocksDisplay blocks={[block]} isStreaming startedAt={start} />, { wrapper })
  await act(async () => {})
  act(() => { vi.advanceTimersByTime(2000) })
  const summary = screen.getByTestId('processing-summary-header')
  expect(summary).toHaveTextContent('2 秒')
  if (hidden === 'retained') active = false
  else visible = false
  view.rerender(<ToolBlocksDisplay blocks={[block]} isStreaming startedAt={start} />)
  act(() => { document.dispatchEvent(new Event('visibilitychange')) })
  const text = summary.textContent, reads = metadata.mock.calls.length
  act(() => { vi.advanceTimersByTime(3000) })
  expect(summary.textContent).toBe(text)
  expect(metadata).toHaveBeenCalledTimes(reads)
  active = visible = true
  view.rerender(<ToolBlocksDisplay blocks={[block]} isStreaming startedAt={start} />)
  act(() => { document.dispatchEvent(new Event('visibilitychange')) })
  expect(summary).toHaveTextContent('5 秒')
  view.unmount()
  expect(vi.getTimerCount()).toBe(0)
})

test('a hidden summary records completion once and never resumes its finished ticker', async () => {
  vi.useFakeTimers()
  vi.setSystemTime(start)
  let active = true
  const wrapper = ({ children }: { children: ReactNode }) => <RetainedPage open={active}>{children}</RetainedPage>
  const view = render(<ToolBlocksDisplay blocks={[block]} isStreaming startedAt={start} />, { wrapper })
  await act(async () => {})
  active = false
  view.rerender(<ToolBlocksDisplay blocks={[block]} isStreaming startedAt={start} />)
  act(() => { vi.advanceTimersByTime(3000) })
  const done = { ...block, status: 'done' as const }
  view.rerender(<ToolBlocksDisplay blocks={[done]} isStreaming={false} startedAt={start} />)
  act(() => { vi.advanceTimersByTime(0) })
  active = true
  view.rerender(<ToolBlocksDisplay blocks={[done]} isStreaming={false} startedAt={start} />)
  act(() => { vi.advanceTimersByTime(60000) })
  expect(screen.getByTestId('processing-summary-toggle')).toHaveAccessibleName(/已处理 3 秒/)
  view.unmount()
  expect(vi.getTimerCount()).toBe(0)
})
