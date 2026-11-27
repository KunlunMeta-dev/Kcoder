import { act, render, screen, waitFor } from '@testing-library/react'
import { expect, test, vi } from 'vitest'
import { ScrollableMessageArea } from '../ScrollableMessageArea'
import type { ImportedHistoryPanelProps } from './ImportedHistoryPanel'
import '@/i18n'

const history = vi.hoisted(() => {
  let release!: () => void
  const ready = new Promise<void>(resolve => { release = resolve })
  return {
    ready, release,
    loaded: vi.fn(),
    source: null as null | { operationId: string; sourceJobId: string; viewId: string },
    current: () => true,
    read: vi.fn(),
  }
})
vi.mock('./ImportedHistoryContent', async () => {
  history.loaded()
  await history.ready
  return { ImportedHistoryContent: (props: ImportedHistoryPanelProps) => {
    history.read(props.deviceId, props.workspacePath, props.source.sourceJobId, props.isCurrent, props.source.viewId)
    return <div data-testid="imported-conversation-history">Selected history</div>
  } }
})
vi.mock('@/kcoder/useImportedHistory', () => ({
  useImportedHistory: () => ({ source: history.source, isCurrent: history.current }),
}))
vi.mock('../MessageList', () => ({ MessageList: () => <p>Current conversation remains usable</p> }))

test('ordinary conversations skip historical UI; delayed loading cannot reopen a retired history', async () => {
  const props = { toolsCatalogServerId: 'owned-target', messages: [
    { id: 'current', role: 'user' as const, content: 'Current', status: 'done' as const, createdAt: '2026-11-22T00:00:00Z' },
  ] }
  const view = render(<ScrollableMessageArea {...props} />)
  const current = screen.getByText('Current conversation remains usable')
  expect(history.loaded).not.toHaveBeenCalled()
  history.source = { operationId: 'first', sourceJobId: 'first-archive', viewId: 'first-view' }
  view.rerender(<ScrollableMessageArea {...props} importedHistoryTaskId="kcoder:owned-target:first" />)
  await waitFor(() => expect(history.loaded).toHaveBeenCalledOnce())
  expect(screen.getByTestId('imported-history-module-status')).toHaveAttribute('aria-busy', 'true')
  expect(history.read).not.toHaveBeenCalled()
  history.source = null
  view.rerender(<ScrollableMessageArea {...props} />)
  await act(async () => { history.release(); await vi.dynamicImportSettled() })
  expect(screen.queryByTestId('imported-conversation-history')).not.toBeInTheDocument()
  expect(history.read).not.toHaveBeenCalled()
  history.source = { operationId: 'second', sourceJobId: 'second-archive', viewId: 'second-view' }
  view.rerender(<ScrollableMessageArea {...props} importedHistoryTaskId="kcoder:owned-target:second" />)
  await screen.findByTestId('imported-conversation-history')
  expect(history.read).toHaveBeenLastCalledWith('owned-target', undefined, 'second-archive', history.current, 'second-view')
  expect(screen.getByText('Current conversation remains usable')).toBe(current)
})
