import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import '@/i18n'
import { MigrationMemorySources } from './MigrationMemorySources'
const api = vi.hoisted(() => ({ memoryDiscover: vi.fn(), memorySources: vi.fn(), scanBatch: vi.fn() }))
vi.mock('@/kcoder/gatewayMigration', () => ({ createMigrationApi: () => api }))
const source = (id: string) => ({ sourceId: id, source: 'claude-code', sourceGroup: 'opaque-project-label', layout: 'claude_auto_memory_v1', files: 1, bytes: 42, blockedItems: 0 })
beforeEach(() => vi.clearAllMocks())
afterEach(() => { delete window.__KCODER_STUDIO_RUNTIME_CONFIG__ })
it('discovers memory only on explicit action, pages the same catalog and opens the ordinary batch', async () => {
  const open = vi.fn(), busy = vi.fn()
  api.memoryDiscover.mockResolvedValue({ catalogId: 'catalog-owned', items: Array.from({ length: 10 }, (_, i) => source(String(i))), nextCursor: 'page2', problems: [], unobserved: ['external_runtime_memory'] })
  api.memorySources.mockResolvedValue({ catalogId: 'catalog-owned', items: [source('last')], nextCursor: null, problems: [], unobserved: [] })
  api.scanBatch.mockResolvedValue({ job: { jobId: 'mig-owned' } })
  render(<MigrationMemorySources deviceId="target" isCurrent={() => true} onOpenBatch={open} onBusy={busy}/>)
  expect(api.memoryDiscover).not.toHaveBeenCalled()
  fireEvent.click(screen.getByText('查找记忆来源')); await screen.findAllByTestId('memory-source')
  expect(screen.getAllByTestId('memory-source')).toHaveLength(10)
  fireEvent.click(screen.getByText('下一页')); await waitFor(() => expect(screen.getAllByTestId('memory-source')).toHaveLength(1))
  expect(api.memorySources).toHaveBeenCalledWith({ catalogId: 'catalog-owned', cursor: 'page2' })
  fireEvent.click(screen.getByText('打开记忆迁移预览')); await waitFor(() => expect(open).toHaveBeenCalledWith('mig-owned'))
  expect(api.scanBatch).toHaveBeenCalledWith({ sourceIds: ['last'] })
})
it('drops a late discovery result after closing the source panel', async () => {
  let finish!: (value: unknown) => void
  api.memoryDiscover.mockImplementation(() => new Promise(resolve => { finish = resolve }))
  const open = vi.fn(), view = render(<MigrationMemorySources deviceId="target" isCurrent={() => true} onOpenBatch={open} onBusy={vi.fn()}/>)
  fireEvent.click(screen.getByText('查找记忆来源')); view.unmount()
  await act(async () => finish({ catalogId: 'old', items: [source('old')], nextCursor: null, problems: [], unobserved: [] }))
  expect(open).not.toHaveBeenCalled(); expect(api.scanBatch).not.toHaveBeenCalled()
})
it('does not publish a late source result after changing the Relay mount', async () => {
  let finish!: (value: unknown) => void
  api.memoryDiscover.mockImplementation(() => new Promise(resolve => { finish = resolve }))
  window.__KCODER_STUDIO_RUNTIME_CONFIG__ = { appBasePath: '/first' }
  render(<MigrationMemorySources deviceId="target" isCurrent={() => true} onOpenBatch={vi.fn()} onBusy={vi.fn()}/>)
  fireEvent.click(screen.getByText('查找记忆来源'))
  window.__KCODER_STUDIO_RUNTIME_CONFIG__ = { appBasePath: '/second' }
  await act(async () => finish({ catalogId: 'old', items: [source('old')], nextCursor: null, problems: [], unobserved: [] }))
  expect(screen.queryByTestId('memory-source')).toBeNull()
})
