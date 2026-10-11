import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import { ProcessingWindow } from './ProcessingWindow'
import { MessageList } from './MessageList'
import { clearPersistentProcessingExpansions } from './blocks/processingExpansionState'
import type { WorkbenchMessage } from '@/types/workbench'
import '@/i18n'

const resizeCallbacks = new Set<() => void>()
beforeEach(() => {
  vi.stubGlobal(
    'ResizeObserver',
    class {
      constructor(private callback: () => void) {}
      observe() {
        resizeCallbacks.add(this.callback)
      }
      disconnect() {
        resizeCallbacks.delete(this.callback)
      }
    }
  )
})
afterEach(() => {
  cleanup()
  clearPersistentProcessingExpansions()
  resizeCallbacks.clear()
  vi.unstubAllGlobals()
})

test('completion collapses activity, keeps the final reply outside, and reopens the same window', () => {
  const message: WorkbenchMessage = {
    id: 'window-assistant',
    role: 'assistant',
    content: '',
    status: 'streaming',
    createdAt: '2026-10-10T10:00:00Z',
    blocks: [
      {
        id: 'step',
        subtaskId: 1,
        type: 'thinking',
        content: 'Intermediate activity',
        status: 'streaming',
        createdAt: 1,
      },
    ],
  }
  const { rerender } = render(<MessageList processingWindowEnabled messages={[message]} />)
  expect(screen.queryByTestId('final-processing-toggle')).not.toBeInTheDocument()
  expect(screen.getByTestId('processing-window-scroll')).toHaveTextContent('Intermediate activity')
  rerender(
    <MessageList
      processingWindowEnabled
      messages={[
        {
          ...message,
          status: 'done',
          content: 'Final answer',
          blocks: message.blocks?.map(block => ({ ...block, status: 'done' })),
        },
      ]}
    />
  )
  expect(screen.getByTestId('final-processing-toggle')).toHaveAttribute('aria-expanded', 'false')
  expect(screen.queryByTestId('processing-window-scroll')).not.toBeInTheDocument()
  expect(screen.queryByTestId('processing-window')).not.toBeInTheDocument()
  expect(screen.getByText('Final answer')).toBeVisible()
  fireEvent.click(screen.getByTestId('final-processing-toggle'))
  fireEvent.click(screen.getByTestId('assistant-thinking-toggle'))
  expect(screen.getByTestId('processing-window-scroll')).toHaveTextContent('Intermediate activity')
})

test('stays at the user reading position when activity grows and resumes following on request', () => {
  render(
    <ProcessingWindow stateKey="reading">
      <p>Activity</p>
    </ProcessingWindow>
  )
  const scroll = screen.getByTestId('processing-window-scroll')
  let height = 1000
  Object.defineProperties(scroll, {
    scrollHeight: { get: () => height },
    clientHeight: { get: () => 320 },
  })
  act(() => resizeCallbacks.forEach(callback => callback()))
  expect(scroll.scrollTop).toBe(1000)
  scroll.scrollTop = 120
  fireEvent.scroll(scroll)
  height = 1500
  act(() => resizeCallbacks.forEach(callback => callback()))
  expect(scroll.scrollTop).toBe(120)
  fireEvent.click(screen.getByTestId('processing-window-latest'))
  expect(scroll.scrollTop).toBe(1500)
})

test('interruption collapses activity and does not hide the stopped notice', () => {
  const message: WorkbenchMessage = {
    id: 'interrupted-window',
    role: 'assistant',
    content: '',
    status: 'streaming',
    createdAt: '',
    blocks: [
      {
        id: 'step',
        subtaskId: 1,
        type: 'thinking',
        content: 'Activity before stopping',
        status: 'streaming',
        createdAt: 1,
      },
    ],
  }
  const { rerender } = render(<MessageList processingWindowEnabled messages={[message]} />)
  rerender(
    <MessageList
      processingWindowEnabled
      messages={[{ ...message, status: 'done', runtimeStatus: 'cancelled' }]}
    />
  )
  expect(screen.getByTestId('final-processing-toggle')).toHaveAttribute('aria-expanded', 'false')
  expect(screen.getByTestId('assistant-stopped-notice')).toBeVisible()
})

test('keeps ordinary text outside chronological activity groups after completion', () => {
  const message: WorkbenchMessage = {
    id: 'mixed-process',
    role: 'assistant',
    content: '',
    status: 'streaming',
    createdAt: '',
    blocks: [
      {
        id: 'reason-a',
        subtaskId: 1,
        type: 'thinking',
        content: 'First reasoning',
        status: 'done',
        createdAt: 1,
      },
      {
        id: 'read-a',
        subtaskId: 1,
        type: 'tool',
        toolName: 'read',
        toolInput: { path: 'a.txt' },
        status: 'done',
        createdAt: 2,
      },
      {
        id: 'normal',
        subtaskId: 1,
        type: 'text',
        content: 'Ordinary progress update',
        status: 'done',
        createdAt: 3,
      },
      {
        id: 'read-b',
        subtaskId: 1,
        type: 'tool',
        toolName: 'read',
        toolInput: { path: 'b.txt' },
        status: 'done',
        createdAt: 4,
      },
      {
        id: 'reason-b',
        subtaskId: 1,
        type: 'thinking',
        content: 'Latest reasoning',
        status: 'streaming',
        createdAt: 5,
      },
    ],
  }
  const { rerender } = render(<MessageList processingWindowEnabled messages={[message]} />)
  const groups = screen.getAllByTestId('processing-group')
  expect(within(groups[0]).getByTestId('final-processing-toggle')).toHaveAttribute(
    'aria-expanded',
    'false'
  )
  expect(within(groups[0]).queryByTestId('processing-window-toggle')).not.toBeInTheDocument()
  expect(screen.getAllByTestId('processing-window-toggle')).toHaveLength(1)
  fireEvent.click(within(groups[0]).getByTestId('final-processing-toggle'))
  const windows = screen.getAllByTestId('processing-window-scroll')
  expect(windows).toHaveLength(2)
  const normal = screen.getByText('Ordinary progress update')
  windows.forEach(window => expect(window).not.toContainElement(normal))
  expect(windows[0].compareDocumentPosition(normal) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
  expect(normal.compareDocumentPosition(windows[1]) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
  rerender(
    <MessageList
      processingWindowEnabled
      messages={[
        {
          ...message,
          status: 'done',
          content: 'Final response',
          blocks: message.blocks?.map(block => ({ ...block, status: 'done' })),
        },
      ]}
    />
  )
  expect(screen.getByText('Ordinary progress update')).toBeVisible()
  expect(screen.getByText('Final response')).toBeVisible()
  expect(screen.queryByTestId('processing-window-scroll')).not.toBeInTheDocument()
  screen
    .getAllByTestId('final-processing-toggle')
    .forEach(toggle => expect(toggle).toHaveAttribute('aria-expanded', 'false'))
})

test('settles each group before the following narrative while the turn continues streaming', () => {
  const message: WorkbenchMessage = {
    id: 'activity-lifecycle',
    role: 'assistant',
    content: '',
    status: 'streaming',
    createdAt: '',
    blocks: [
      {
        id: 'read-first',
        subtaskId: 1,
        type: 'tool',
        toolName: 'read',
        toolInput: { path: 'a.txt' },
        status: 'pending',
        createdAt: 1,
      },
    ],
  }
  const { rerender } = render(<MessageList processingWindowEnabled messages={[message]} />)
  expect(screen.getAllByTestId('processing-window-toggle')).toHaveLength(1)

  const nextMessage: WorkbenchMessage = {
    ...message,
    blocks: [
      { ...message.blocks![0], status: 'done' },
      {
        id: 'normal-update',
        subtaskId: 1,
        type: 'text',
        content: 'The first file is ready.',
        status: 'done',
        createdAt: 2,
      },
      {
        id: 'reason-next',
        subtaskId: 1,
        type: 'thinking',
        content: 'Checking the next file',
        status: 'streaming',
        createdAt: 3,
      },
    ],
  }
  rerender(<MessageList processingWindowEnabled messages={[nextMessage]} />)
  const firstGroup = screen.getAllByTestId('processing-group')[0]
  expect(within(firstGroup).getByTestId('final-processing-toggle')).toHaveAttribute(
    'aria-expanded',
    'false'
  )
  expect(within(firstGroup).queryByTestId('processing-window-scroll')).not.toBeInTheDocument()
  expect(screen.getAllByTestId('processing-window-toggle')).toHaveLength(1)
  expect(screen.getByTestId('assistant-thinking-spinner')).toBeInTheDocument()
  expect(screen.getByText('The first file is ready.')).toBeVisible()

  fireEvent.click(within(firstGroup).getByTestId('final-processing-toggle'))
  rerender(
    <MessageList
      processingWindowEnabled
      messages={[
        {
          ...nextMessage,
          blocks: nextMessage.blocks?.map(block =>
            block.type === 'thinking'
              ? { ...block, content: `${block.content} with a delta` }
              : block
          ),
        },
      ]}
    />
  )
  expect(within(firstGroup).getByTestId('final-processing-toggle')).toHaveAttribute(
    'aria-expanded',
    'true'
  )
  expect(within(firstGroup).queryByTestId('processing-window-toggle')).not.toBeInTheDocument()

  rerender(
    <MessageList
      processingWindowEnabled
      messages={[
        {
          ...nextMessage,
          content: 'The final answer is streaming',
          blocks: nextMessage.blocks?.map(block => ({ ...block, status: 'done' })),
        },
      ]}
    />
  )
  expect(screen.queryByTestId('processing-window-toggle')).not.toBeInTheDocument()
  expect(screen.queryByTestId('assistant-thinking-spinner')).not.toBeInTheDocument()
  expect(screen.getByText('The final answer is streaming')).toBeVisible()
})

test('reopens a settled group when new activity starts without overriding a manual live fold', () => {
  const message: WorkbenchMessage = {
    id: 'reactivated-group',
    role: 'assistant',
    content: '',
    status: 'streaming',
    createdAt: '',
    blocks: [
      {
        id: 'first-step',
        subtaskId: 1,
        type: 'thinking',
        content: 'Reasoning complete',
        status: 'done',
        createdAt: 1,
      },
    ],
  }
  const { rerender } = render(<MessageList processingWindowEnabled messages={[message]} />)
  expect(screen.getByTestId('final-processing-toggle')).toHaveAttribute('aria-expanded', 'false')
  const nextMessage: WorkbenchMessage = {
    ...message,
    blocks: [
      ...message.blocks!,
      {
        id: 'next-step',
        subtaskId: 1,
        type: 'tool',
        toolName: 'read',
        toolInput: { path: 'next.txt' },
        status: 'generating_arguments',
        createdAt: 2,
      },
    ],
  }
  rerender(<MessageList processingWindowEnabled messages={[nextMessage]} />)
  expect(screen.getByTestId('processing-window-toggle')).toHaveAttribute('aria-expanded', 'true')
  fireEvent.click(screen.getByTestId('processing-window-toggle'))
  rerender(
    <MessageList
      processingWindowEnabled
      messages={[
        {
          ...nextMessage,
          blocks: nextMessage.blocks?.map(block =>
            block.type === 'tool' ? { ...block, status: 'pending' } : block
          ),
        },
      ]}
    />
  )
  expect(screen.getByTestId('processing-window-toggle')).toHaveAttribute('aria-expanded', 'false')
})

test('failure settles the group even when the last snapshot still marks thinking as streaming', () => {
  const message: WorkbenchMessage = {
    id: 'failed-activity',
    role: 'assistant',
    content: '',
    status: 'streaming',
    createdAt: '',
    blocks: [
      {
        id: 'failed-thinking',
        subtaskId: 1,
        type: 'thinking',
        content: 'Activity before failure',
        status: 'streaming',
        createdAt: 1,
      },
    ],
  }
  const { rerender } = render(<MessageList processingWindowEnabled messages={[message]} />)
  rerender(
    <MessageList
      processingWindowEnabled
      messages={[{ ...message, status: 'failed', error: 'Connection failed' }]}
    />
  )
  expect(screen.queryByTestId('processing-window-toggle')).not.toBeInTheDocument()
  expect(screen.getByTestId('final-processing-toggle')).toHaveAttribute('aria-expanded', 'false')
  expect(screen.getByTestId('assistant-error-card')).toBeVisible()
  fireEvent.click(screen.getByTestId('final-processing-toggle'))
  expect(screen.queryByTestId('assistant-thinking-spinner')).not.toBeInTheDocument()
})
