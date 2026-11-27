import type { ReactNode } from 'react'
import { act, render, screen } from '@testing-library/react'
import { afterEach, expect, test, vi } from 'vitest'
import { RetainedPage } from '@/components/layout/retainedPages'
import { ToolsCatalogContext } from '@/kcoder/toolsCatalogContext'
import type { ProcessingBlock } from '@/types/workbench'
import { ToolBlockItem } from './ToolBlockItem'
import '@/i18n'

const start = 1_800_000_000_000
const tool: ProcessingBlock = { id: 'timed-tool', type: 'tool', toolName: 'timed-operation', status: 'streaming', createdAt: start }
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks() })

test('text has no duration timer and thinking has only its own second-precision clock', async () => {
  vi.useFakeTimers()
  vi.setSystemTime(start)
  const view = render(<ToolBlockItem block={{ id: 'text', type: 'text', content: 'Progress', status: 'streaming', createdAt: start }} />)
  await act(async () => {})
  expect(vi.getTimerCount()).toBe(0)
  view.rerender(<ToolBlockItem block={{ id: 'thought', type: 'thinking', content: 'Inspecting', status: 'streaming', createdAt: start }} />)
  await act(async () => {})
  expect(vi.getTimerCount()).toBe(1)
})

test('clock ticks update tool duration without rediscovering unchanged tool metadata', async () => {
  vi.useFakeTimers()
  vi.setSystemTime(start)
  const catalog = new Map()
  const readMetadata = vi.spyOn(catalog, 'get')
  render(<ToolsCatalogContext.Provider value={catalog}><ToolBlockItem block={tool} /></ToolsCatalogContext.Provider>)
  await act(async () => {})
  const reads = readMetadata.mock.calls.length
  expect(screen.getByTestId('tool-block-duration')).toHaveTextContent('0.0s')
  act(() => { vi.advanceTimersByTime(1200) })
  expect(screen.getByTestId('tool-block-duration')).toHaveTextContent('1.2s')
  expect(readMetadata).toHaveBeenCalledTimes(reads)
})

test('hidden tool details stop their ticker, preserve observed completion and resume no completed clock', async () => {
  vi.useFakeTimers()
  vi.setSystemTime(start)
  let active = true
  const wrapper = ({ children }: { children: ReactNode }) => <RetainedPage open={active}>{children}</RetainedPage>
  const view = render(<ToolBlockItem block={tool} />, { wrapper })
  await act(async () => {})
  act(() => { vi.advanceTimersByTime(1200) })
  expect(screen.getByTestId('tool-block-duration')).toHaveTextContent('1.2s')
  active = false
  view.rerender(<ToolBlockItem block={tool} />)
  expect(vi.getTimerCount()).toBe(0)
  act(() => { vi.advanceTimersByTime(1300) })
  view.rerender(<ToolBlockItem block={{ ...tool, status: 'done' }} />)
  expect(screen.getByTestId('tool-block-duration')).toHaveTextContent('2.5s')
  active = true
  view.rerender(<ToolBlockItem block={{ ...tool, status: 'done' }} />)
  act(() => { vi.advanceTimersByTime(60_000) })
  expect(screen.getByTestId('tool-block-duration')).toHaveTextContent('2.5s')
  expect(vi.getTimerCount()).toBe(0)
})
