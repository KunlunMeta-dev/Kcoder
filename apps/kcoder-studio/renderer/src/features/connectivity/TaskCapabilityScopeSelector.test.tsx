import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { TaskCapabilityScopeSelector, type SavedTaskCapabilityScopePage } from './TaskCapabilityScopeSelector'
import messages from '@/i18n/locales/zh-CN/taskCapabilityScope.json'

vi.mock('@/hooks/useTranslation', () => ({ useTranslation: () => ({ t: (key: string, values?: Record<string, unknown>) => {
  const dictionary = messages as Record<string, string>
  const value = dictionary[key] ?? dictionary[`${key}_other`] ?? key
  return value.replace(/\{\{(\w+)\}\}/g, (_, name: string) => String(values?.[name] ?? ''))
} }) }))
type Target = { initialAttempt: { threadId: string; turnId: string; attemptId: string }; runtimeOperationId?: string }
const target: Target = { initialAttempt: { threadId: 'native-thread', turnId: 'original-turn', attemptId: 'original-attempt' }, runtimeOperationId: 'original-runtime' }
function page(title = '已接纳的资料整理任务'): SavedTaskCapabilityScopePage<Target> {
  return { entries: [{ referenceId: 'saved-original-reference', target, title, observationState: 'saved_only', reasonCode: 'TASK_CAPABILITY_SCOPE_LIVE_AUTHORITY_NOT_OBSERVED', savedSnapshot: { threadId: 'native-thread', revision: 4, selection: { mode: 'none', sources: [] }, effectiveSources: [], effectiveFrom: 'current_snapshot' } }], nextCursor: null, observationState: 'saved_only', reasonCode: null }
}
describe('original saved source binding chooser', () => {
  it('passes the exact original target to a read callback and shows saved state separately from authority', async () => {
    const choose = vi.fn().mockResolvedValue(undefined)
    render(<TaskCapabilityScopeSelector ownerKey="native-owner" loadPage={vi.fn().mockResolvedValue(page())} onChoose={choose} />)
    fireEvent.click(await screen.findByRole('button', { name: /已接纳的资料整理任务/ }))
    await waitFor(() => expect(choose).toHaveBeenCalledWith(target))
    expect(screen.getByText('已保存')).toBeInTheDocument()
    expect(screen.getByText('不使用外部工具提供方')).toBeInTheDocument()
    expect(screen.getByText(messages.authorityHint)).toBeInTheDocument()
  })
  it('never renders unknown empty data as an explicit none selection', async () => {
    render(<TaskCapabilityScopeSelector<Target> ownerKey="native-owner" loadPage={vi.fn().mockResolvedValue({ entries: [], nextCursor: null, observationState: 'unknown', reasonCode: 'TASK_CAPABILITY_SCOPE_BINDINGS_NOT_OBSERVED' })} onChoose={vi.fn()} />)
    expect(await screen.findByText(messages.unknownDirectory)).toBeInTheDocument()
    expect(screen.queryByText(messages.none)).not.toBeInTheDocument()
    expect(screen.queryByText(messages.empty)).not.toBeInTheDocument()
  })
  it('keeps bounded filtered pages readable and does not invent a target for an unreadable record', async () => {
    const load = vi.fn().mockResolvedValueOnce({ entries: [], nextCursor: 'original-cursor', observationState: 'saved_only', reasonCode: null })
      .mockResolvedValueOnce({ ...page(), entries: [{ referenceId: 'unknown-row', target: null, savedSnapshot: null, observationState: 'unknown', reasonCode: 'TASK_CAPABILITY_SCOPE_SAVED_RECORD_UNREADABLE' }], nextCursor: null })
    const choose = vi.fn()
    render(<TaskCapabilityScopeSelector ownerKey="native-owner" loadPage={load} onChoose={choose} />)
    fireEvent.click(await screen.findByRole('button', { name: '读取更多' }))
    expect(load).toHaveBeenLastCalledWith('original-cursor')
    expect(await screen.findByRole('button', { name: /待核对/ })).toBeDisabled()
    expect(choose).not.toHaveBeenCalled()
  })
  it('drops old target/profile reads after ownership changes', async () => {
    let finishOld!: (value: SavedTaskCapabilityScopePage<Target>) => void
    const old = vi.fn().mockImplementation(() => new Promise<SavedTaskCapabilityScopePage<Target>>(resolve => { finishOld = resolve }))
    const view = render(<TaskCapabilityScopeSelector ownerKey="old-profile" loadPage={old} onChoose={vi.fn()} />)
    const choose = vi.fn().mockResolvedValue(undefined)
    view.rerender(<TaskCapabilityScopeSelector ownerKey="new-profile" loadPage={vi.fn().mockResolvedValue(page('新目标任务'))} onChoose={choose} />)
    await screen.findByRole('button', { name: /新目标任务/ })
    await act(async () => { finishOld(page('旧目标任务')) })
    expect(screen.queryByText('旧目标任务')).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: /新目标任务/ }))
    await waitFor(() => expect(choose).toHaveBeenCalledOnce())
  })
  it('drops a previous owner’s late read callback failure', async () => {
    let rejectOld!: (reason: Error) => void
    const choose = vi.fn().mockImplementation(() => new Promise<void>((_, reject) => { rejectOld = reject }))
    const view = render(<TaskCapabilityScopeSelector ownerKey="old-profile" loadPage={vi.fn().mockResolvedValue(page('旧任务'))} onChoose={choose} />)
    fireEvent.click(await screen.findByRole('button', { name: /旧任务/ }))
    await waitFor(() => expect(choose).toHaveBeenCalledOnce())
    view.rerender(<TaskCapabilityScopeSelector ownerKey="new-profile" loadPage={vi.fn().mockResolvedValue(page('新任务'))} onChoose={vi.fn()} />)
    await screen.findByRole('button', { name: /新任务/ })
    await act(async () => { rejectOld(new Error('OLD_TARGET_READ_UNAVAILABLE')) })
    expect(screen.queryByText(messages.chooseFailed)).not.toBeInTheDocument()
  })
})
