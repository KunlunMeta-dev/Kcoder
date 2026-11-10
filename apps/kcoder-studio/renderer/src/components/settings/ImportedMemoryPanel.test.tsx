import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, expect, it, vi } from 'vitest'
import '@/i18n'
import { ImportedMemoryPanel } from './ImportedMemoryPanel'
const { api, current } = vi.hoisted(() => ({ api: { memoryList: vi.fn(), memoryRead: vi.fn(), memoryControl: vi.fn(), memoryControlRead: vi.fn() }, current: vi.fn(() => true) }))
vi.mock('@/kcoder/gatewayMigration', () => ({ createMigrationApi: () => api }))
vi.mock('@/kcoder/usePluginTargetScope', () => ({ usePluginTargetScope: () => ({ key: 'scope', isCurrent: current }) }))
const target = { id: 'owned', runtime: 'kcoder' as const, label: 'Owned', description: '', transport: 'local' as const }
const row = { id: 'ctx-owned', ownerOperationId: 'owned-op', name: 'Original notes', enabled: false, revision: 'v1', bytes: 9, scope: { kind: 'global' }, provenance: { source: 'claude-code', layout: 'claude_auto_memory_v1', sourceGroup: 'opaque-bucket', sourceFile: 'MEMORY.md', sourceRevision: 'original', sourceModifiedAtMs: null, factsVerified: false, migrationJobId: 'mig-owned' } }
beforeEach(() => { vi.clearAllMocks(); localStorage.clear(); current.mockReturnValue(true); api.memoryList.mockResolvedValue({ items: [row], totalRecords: 1, nextPage: null }) })
it('reads only on request, requires a second enable confirmation, and distinguishes the original receipt from later current state', async () => {
  const onOpenJob = vi.fn()
  render(<ImportedMemoryPanel target={target} onImport={vi.fn()} onOpenJob={onOpenJob}/>)
  expect(api.memoryList).not.toHaveBeenCalled()
  fireEvent.click(screen.getByText('查看或刷新笔记')); await screen.findByText('Original notes')
  expect(api.memoryRead).not.toHaveBeenCalled()
  fireEvent.click(screen.getByText('启用', { exact: true })); expect(api.memoryControl).not.toHaveBeenCalled()
  fireEvent.click(screen.getByText('取消', { exact: true })); expect(api.memoryControl).not.toHaveBeenCalled()
  fireEvent.click(screen.getByText('启用', { exact: true }))
  api.memoryControl.mockImplementation(async request => ({ receipt: { request, appliedRevision: 'v2' }, current: { ...row, revision: 'v3', enabled: false } }))
  fireEvent.click(screen.getByText('确认启用笔记'))
  await screen.findByText('原操作回执：已提交启用。')
  expect(screen.getByText('当前观察：笔记已停用。')).toBeTruthy()
  expect(screen.getByText('当前版本已不同于原操作回执，请按当前状态判断。')).toBeTruthy()
  expect(api.memoryControl).toHaveBeenCalledOnce()
  expect(api.memoryControl.mock.calls[0][0]).toMatchObject({ id: row.id, ownerOperationId: row.ownerOperationId, expectedRevision: row.revision, enabled: true, confirmUnverifiedNotes: true })
  fireEvent.click(screen.getByText('确认结果并刷新列表'))
  await waitFor(() => expect(api.memoryList).toHaveBeenCalledTimes(2))
  fireEvent.click(screen.getByText('查看详细出处与撤销入口'))
  expect(screen.getByText('来源修改时间未知')).toBeTruthy()
  expect(screen.getByText('事实未经验证。')).toBeTruthy()
  fireEvent.click(screen.getByText('打开原迁移记录')); expect(onOpenJob).toHaveBeenCalledWith('mig-owned')
})
it('keeps lost control outcomes unresolved after remount and checks the original request without replay', async () => {
  api.memoryControl.mockRejectedValue(new Error('lost response'))
  const view = render(<ImportedMemoryPanel target={target} onImport={vi.fn()} onOpenJob={vi.fn()}/>)
  fireEvent.click(screen.getByText('查看或刷新笔记')); await screen.findByText('Original notes')
  fireEvent.click(screen.getByText('启用', { exact: true })); fireEvent.click(screen.getByText('确认启用笔记'))
  await screen.findByText('结果尚未确认，请检查原操作，不要创建第二次修改。')
  const request = api.memoryControl.mock.calls[0][0]
  view.unmount()
  render(<ImportedMemoryPanel target={target} onImport={vi.fn()} onOpenJob={vi.fn()}/>)
  expect(api.memoryControlRead).not.toHaveBeenCalled()
  api.memoryControlRead.mockResolvedValue({ receipt: { request, appliedRevision: 'v2' }, current: { ...row, enabled: true, revision: 'v2' } })
  await act(async () => fireEvent.click(screen.getByText('检查原操作')))
  expect(api.memoryControlRead).toHaveBeenCalledWith({ requestId: request.requestId })
  expect(api.memoryControl).toHaveBeenCalledOnce()
  expect(screen.getByText('当前观察：笔记已启用。')).toBeTruthy()
})
