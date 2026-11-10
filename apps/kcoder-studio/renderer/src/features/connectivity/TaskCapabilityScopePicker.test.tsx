import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { TaskCapabilityScopePicker } from './TaskCapabilityScopePicker'
import { sourceChoice, validTaskCapabilityScopeSelection } from './task-capability-scope-selection'
import type { IntegrationTaskCapabilitySourceDescriptor, IntegrationTaskCapabilityScopeSnapshot } from '../../../../shared/generated/contracts'
vi.mock('@/hooks/useTranslation', () => ({ useTranslation: () => ({ i18n: { language: 'zh-CN' } }) }))
function descriptor(account: string, state: IntegrationTaskCapabilitySourceDescriptor['state'] = 'ready'): IntegrationTaskCapabilitySourceDescriptor { return { sourceRef: { id: 'mail-connector', revision: 'security-v2' }, accountRef: { id: account, revision: 'account-v3' }, kind: 'plugin_mcp', displayName: '办公邮箱', accountDisplayName: account, capabilities: ['tools', 'resources'], state, reasonCode: state === 'ready' ? null : 'ACCOUNT_IDENTITY_UNKNOWN' } }
function snapshot(): IntegrationTaskCapabilityScopeSnapshot { return { threadId: 'native-thread', revision: 7, selection: { mode: 'inherit_current', sources: [] }, effectiveSources: [], effectiveFrom: 'next_tool_boundary' } }
describe('task sources from native configuration references', () => {
  it('commits exact source/account revisions and never treats an unknown identity as selectable', async () => {
    const a = descriptor('账户 A'), b = descriptor('账户 B'), unknown = descriptor('未知账户', 'unknown'), commit = vi.fn().mockResolvedValue(undefined)
    render(<TaskCapabilityScopePicker snapshot={snapshot()} ownerKey="target-native-fence" descriptors={[a, b, unknown]} catalogState="observed" onCommit={commit} />)
    fireEvent.click(screen.getByRole('radio', { name: '仅使用所选工具提供方' }))
    expect(screen.getByRole('checkbox', { name: /未知账户/ })).toBeDisabled()
    fireEvent.click(screen.getByRole('checkbox', { name: /账户 A/ })); fireEvent.click(screen.getByRole('checkbox', { name: /账户 B/ }))
    expect(screen.getAllByText('本任务采用：待保存')).toHaveLength(2)
    fireEvent.click(screen.getByRole('button', { name: '保存任务工具与资源范围' }))
    await waitFor(() => expect(commit).toHaveBeenCalledOnce())
    expect(commit.mock.calls[0][0]).toEqual({ threadId: 'native-thread', expectedRevision: 7, ownerKey: 'target-native-fence', selection: { mode: 'selected', sources: [sourceChoice(a), sourceChoice(b)] } })
    expect(screen.getAllByText('实际验证：未验证')).toHaveLength(3)
  })
  it('retains an acknowledged old source revision without silently replacing it', () => {
    const current = descriptor('账户 A'), old = { ...sourceChoice(current), sourceRef: { id: current.sourceRef.id, revision: 'approved-old-version' } }
    const initial = { ...snapshot(), selection: { mode: 'selected' as const, sources: [old] }, effectiveSources: [old] }
    const commit = vi.fn()
    render(<TaskCapabilityScopePicker snapshot={initial} ownerKey="same-target" descriptors={[current]} catalogState="observed" onCommit={commit} />)
    expect(screen.getByText(/原范围仍会保留/)).toBeInTheDocument(); expect(screen.getByRole('checkbox', { name: /账户 A/ })).not.toBeChecked()
    expect(screen.getByRole('button', { name: '保存任务工具与资源范围' })).toBeDisabled(); expect(commit).not.toHaveBeenCalled()
  })
  it('clears external choices in none mode and ignores late save presentation after a target replacement', async () => {
    let complete!: () => void
    const commit = vi.fn().mockImplementation(() => new Promise<void>(resolve => { complete = resolve }))
    const view = render(<TaskCapabilityScopePicker snapshot={snapshot()} ownerKey="old-target" descriptors={[descriptor('账户 A')]} catalogState="unknown" onCommit={commit} />)
    fireEvent.click(screen.getByRole('radio', { name: '不使用外部工具提供方' })); fireEvent.click(screen.getByRole('button', { name: '保存任务工具与资源范围' }))
    await waitFor(() => expect(commit).toHaveBeenCalledOnce()); expect(commit.mock.calls[0][0].selection).toEqual({ mode: 'none', sources: [] })
    view.rerender(<TaskCapabilityScopePicker snapshot={{ ...snapshot(), threadId: 'new-native-thread' }} ownerKey="new-target" descriptors={[]} catalogState="unknown" onCommit={commit} />)
    await act(async () => { complete() })
    expect(screen.queryByText(/已提交保存/)).not.toBeInTheDocument()
    expect(screen.getByRole('radio', { name: '沿用当前会话' })).toBeChecked()
  })
  it('paginates source/account choices and distinguishes global enablement from actual validation', () => {
    const choices = Array.from({ length: 11 }, (_, i) => descriptor('账户 ' + i))
    render(<TaskCapabilityScopePicker snapshot={snapshot()} ownerKey="native-fence" descriptors={choices} catalogState="observed" onCommit={vi.fn()} />)
    expect(screen.getAllByRole('article')).toHaveLength(10)
    fireEvent.click(screen.getByRole('button', { name: '下一页' })); expect(screen.getAllByRole('article')).toHaveLength(1)
    expect(within(screen.getByRole('article')).getByText('实际验证：未验证')).toBeInTheDocument()
    expect(within(screen.getByRole('article')).getByText('全局启用：未确认')).toBeInTheDocument()
  })
  it('does not accept empty selected choices or conflicting versions of the same account', () => {
    const a = sourceChoice(descriptor('account'))
    expect(validTaskCapabilityScopeSelection({ mode: 'selected', sources: [] })).toBe(false)
    expect(validTaskCapabilityScopeSelection({ mode: 'none', sources: [a] })).toBe(false)
    expect(validTaskCapabilityScopeSelection({ mode: 'selected', sources: [a, { ...a, sourceRef: { ...a.sourceRef, revision: 'different' } }] })).toBe(false)
  })
  it('labels an actually verified original version separately without inventing business validation', () => {
    const retained = { ...descriptor('原账户'), reasonCode: 'NATIVE_SOURCE_RETAINED_PLUGIN_VERSION' }
    const choice = sourceChoice(retained), initial = { ...snapshot(), selection: { mode: 'selected' as const, sources: [choice] }, effectiveSources: [choice] }
    render(<TaskCapabilityScopePicker snapshot={initial} ownerKey="original-native-version" descriptors={[retained]} catalogState="observed" onCommit={vi.fn()} />)
    expect(screen.getByText(/本会话持有原插件版本的有效租约/)).toBeInTheDocument()
    expect(screen.getByText('实际验证：未验证')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '保存任务工具与资源范围' })).toBeDisabled()
  })
})
