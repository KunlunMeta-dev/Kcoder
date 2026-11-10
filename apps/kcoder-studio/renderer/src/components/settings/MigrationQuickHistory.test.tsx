import '@/i18n'
import { act, fireEvent, render, screen } from '@testing-library/react'
import { beforeEach, expect, test, vi } from 'vitest'
import { MigrationQuickHistory } from './MigrationQuickHistory'
import type { QuickSnapshot } from '@/kcoder/migrationQuickHistory'
import type { GatewayServer } from '@/kcoder/gatewayRpc'

const mocked = vi.hoisted(() => ({
  state: { phase: 'idle', busy: false, rows: [], warnings: [], error: '' } as QuickSnapshot,
  listeners: new Set<() => void>(), start: vi.fn(), pause: vi.fn(), dispose: vi.fn(),
}))
vi.mock('@/kcoder/migrationQuickHistory', () => ({ QuickHistoryMigration: class {
  getSnapshot = () => mocked.state
  subscribe = (listener: () => void) => { mocked.listeners.add(listener); return () => mocked.listeners.delete(listener) }
  activate = () => {}
  start = mocked.start
  pause = mocked.pause
  dispose = mocked.dispose
} }))
vi.mock('@/kcoder/gatewayMigration', () => ({ createMigrationApi: () => ({}) }))
vi.mock('@/features/workbench/studioWorkMode', () => ({ useStudioWorkMode: () => 'kworker' }))
const target = { id: 'owned', runtime: 'kcoder', transport: 'local', workspacePath: '/work' } as GatewayServer
const props = () => ({ target, workspacePath: '/work', isCurrent: () => true, onBusy: vi.fn() })
beforeEach(() => {
  vi.clearAllMocks(); mocked.listeners.clear()
  mocked.state = { phase: 'idle', busy: false, rows: [], warnings: [], error: '' }
})
test('opening the simple entry does not start work and one click uses both sources and the current product mode', () => {
  render(<MigrationQuickHistory {...props()} />)
  expect(mocked.start).not.toHaveBeenCalled()
  expect(screen.getByLabelText('Claude Code')).toBeChecked()
  expect(screen.getByLabelText('Codex')).toBeChecked()
  fireEvent.click(screen.getByRole('button', { name: '一键迁移所有会话' }))
  expect(mocked.start).toHaveBeenCalledWith(['claude-code', 'codex'], 'kworker')
})
test('source selection remains simple and busy work has a pause action', () => {
  render(<MigrationQuickHistory {...props()} />)
  fireEvent.click(screen.getByLabelText('Codex'))
  fireEvent.click(screen.getByTestId('migration-quick-start'))
  expect(mocked.start).toHaveBeenCalledWith(['claude-code'], 'kworker')
  act(() => { mocked.state = { ...mocked.state, phase: 'archiving', busy: true }; mocked.listeners.forEach(fn => fn()) })
  expect(screen.getByTestId('migration-quick-start')).toBeDisabled()
  expect(screen.getByLabelText('Claude Code')).toBeDisabled()
  fireEvent.click(screen.getByRole('button', { name: '暂停' }))
  expect(mocked.pause).toHaveBeenCalledOnce()
})
test('large result lists show ten rows per page and keep titles as inert text', () => {
  mocked.state = { ...mocked.state, phase: 'complete', rows: Array.from({ length: 25 }, (_, i) => ({
    jobId: String(i), catalogId: 'catalog', archiveReady: i !== 0, status: i === 0 ? 'failed' : 'imported',
    error: i === 0 ? 'migration_operation_failed' : undefined,
    source: { source: 'claude-code', sourceHandle: String(i), sourceSessionId: String(i), sourceArtifactId: null, parentSessionId: null, agentId: null, bytes: 1, modifiedAtMs: null, archived: false, compressed: false, project: null, previewIncomplete: false, importIssues: [], title: i === 0 ? '<script>never_execute()</script>' : `会话 ${i}` },
  })) }
  render(<MigrationQuickHistory {...props()} />)
  expect(screen.getAllByTestId('migration-quick-row')).toHaveLength(10)
  expect(screen.getByTestId('migration-quick-progress')).toHaveTextContent('25 个会话 · 已归档 24 · 已导入 24 · 需检查 1 · 处理中 0')
  expect(screen.getByText('<script>never_execute()</script>')).toBeInTheDocument()
  expect(document.querySelector('script')).toBeNull()
  fireEvent.click(screen.getByRole('button', { name: '下一页' }))
  expect(screen.getAllByTestId('migration-quick-row')).toHaveLength(10)
  fireEvent.click(screen.getByRole('button', { name: '下一页' }))
  expect(screen.getAllByTestId('migration-quick-row')).toHaveLength(5)
})
test('shows the reason a stored conversation cannot be continued', () => {
  mocked.state = { ...mocked.state, phase: 'complete', rows: [{
    jobId: 'job', catalogId: 'catalog', archiveReady: true, status: 'failed',
    error: 'history_context_incomplete_branch',
    source: { source: 'codex', sourceHandle: 'source', sourceSessionId: 'session', sourceArtifactId: null, parentSessionId: null, agentId: null, bytes: 1, modifiedAtMs: null, archived: false, compressed: false, project: null, previewIncomplete: false, importIssues: [], title: '会话' },
  }] }
  render(<MigrationQuickHistory {...props()} />)
  expect(screen.getByText('历史记录缺少可用于接续的完整上下文。原会话已归档，但暂不能安全续接。')).toBeInTheDocument()
})
test('explains a persistent branch-choice conflict without exposing the lock', () => {
  mocked.state = { ...mocked.state, phase: 'complete', rows: [{
    jobId: 'job', catalogId: 'catalog', archiveReady: true, status: 'failed',
    error: 'history_branch_choices_busy',
    source: { source: 'codex', sourceHandle: 'source', sourceSessionId: 'session', sourceArtifactId: null, parentSessionId: null, agentId: null, bytes: 1, modifiedAtMs: null, archived: false, compressed: false, project: null, previewIncomplete: false, importIssues: [], title: '会话' },
  }] }
  render(<MigrationQuickHistory {...props()} />)
  expect(screen.getByText('其他会话仍在完成迁移，请稍后重试。')).toBeInTheDocument()
})
test('closing releases the local observer without replaying or deleting Native work', () => {
  const view = render(<MigrationQuickHistory {...props()} />)
  view.unmount()
  expect(mocked.dispose).toHaveBeenCalledOnce()
  expect(mocked.start).not.toHaveBeenCalled()
  expect(mocked.pause).not.toHaveBeenCalled()
})
