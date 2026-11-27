import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import i18n from '@/i18n'
import zh from '@/i18n/locales/zh-CN/taskComparison.json'
import en from '@/i18n/locales/en/taskComparison.json'
import { TaskComparisonPanel } from './TaskComparisonPanel'
import { comparisonFixture, comparisonScope, fixtureController } from './fixtures.test-support'

i18n.addResourceBundle('zh-CN', 'taskComparison', zh, true, true)
i18n.addResourceBundle('en', 'taskComparison', en, true, true)

describe('alternative comparison from actual task facts', () => {
  it('keeps native failures distinct from model claims and selects the addressed alternative only', async () => {
    const controller = fixtureController()
    const select = vi.spyOn(controller, 'select')
    const create = vi.spyOn(controller, 'create')
    const selected = vi.fn()
    const open = vi.fn()
    render(<TaskComparisonPanel controller={controller} onSelected={selected} onOpenTask={open} />)
    await screen.findByText('Model says all checks passed.')
    expect(screen.getByText('检查失败')).toBeInTheDocument()
    expect(
      screen
        .getAllByTestId('task-comparison-cost')
        .every(node => node.textContent?.includes('未知'))
    ).toBe(true)
    expect(screen.getAllByTestId('task-comparison-usage')[1]).toHaveTextContent('用量未知')
    const rows = screen.getAllByTestId('task-comparison-candidate')
    fireEvent.click(within(rows[0]).getByTestId('task-comparison-check-details'))
    expect(screen.getByText('NATIVE_CHECK_FAILED')).toBeInTheDocument()
    fireEvent.click(within(rows[1]).getByTestId('task-comparison-open-task'))
    expect(open).toHaveBeenCalledWith(
      expect.objectContaining({
        deviceId: 'target-A',
        taskId: 'task-B',
        threadId: 'thread-B',
        workspacePath: '/managed/B',
      })
    )
    fireEvent.click(within(rows[1]).getByTestId('task-comparison-select'))
    await waitFor(() =>
      expect(selected).toHaveBeenCalledWith(expect.objectContaining({ path: '/managed/B' }))
    )
    expect(select).toHaveBeenCalledWith(
      expect.objectContaining({ binding: expect.objectContaining({ threadId: 'thread-B' }) })
    )
    expect(create).not.toHaveBeenCalled()
  })
  it('discards a late comparison read after the owner changes', async () => {
    let resolve!: (result: ReturnType<typeof comparisonFixture>) => void
    const first = fixtureController({
      read: () =>
        new Promise(done => {
          resolve = done
        }),
    })
    const next = fixtureController({
      scope: { ...comparisonScope, ownerThreadId: 'owner-B' },
      read: async () => ({ ...comparisonFixture(), candidates: [] }),
    })
    const view = render(<TaskComparisonPanel controller={first} />)
    view.rerender(<TaskComparisonPanel controller={next} />)
    await screen.findByText(zh.empty)
    resolve(comparisonFixture())
    await waitFor(() =>
      expect(screen.queryByText('Model says all checks passed.')).not.toBeInTheDocument()
    )
  })
  it('preserves the comparison when selection is unconfirmed and never reports it selected', async () => {
    const controller = fixtureController({
      select: async () => {
        throw new Error('unknown native receipt')
      },
    })
    const selected = vi.fn()
    render(<TaskComparisonPanel controller={controller} onSelected={selected} />)
    await screen.findByText('Alternative B completed its report.')
    fireEvent.click(screen.getAllByTestId('task-comparison-select')[1])
    await screen.findByTestId('task-comparison-error')
    expect(screen.getAllByTestId('task-comparison-candidate')).toHaveLength(2)
    expect(selected).not.toHaveBeenCalled()
    expect(screen.queryByTestId('task-comparison-selected')).not.toBeInTheDocument()
  })
  it('requires capability and explicit model/budget context before exposing task execution', async () => {
    const read = vi.fn(async () => comparisonFixture())
    const disabled = fixtureController({ supported: false, canCreate: true, read })
    const view = render(
      <TaskComparisonPanel controller={disabled} creationSummary="model-A · 1000 tokens" />
    )
    expect(screen.getByTestId('task-comparison-unsupported')).toBeInTheDocument()
    expect(read).not.toHaveBeenCalled()
    const controller = fixtureController({ canCreate: true })
    view.rerender(<TaskComparisonPanel controller={controller} />)
    await screen.findByText('Alternative B completed its report.')
    expect(screen.queryByTestId('task-comparison-create')).not.toBeInTheDocument()
    view.rerender(
      <TaskComparisonPanel controller={controller} creationSummary="model-A · 1000 tokens" />
    )
    expect(screen.getByText('model-A · 1000 tokens')).toBeInTheDocument()
    expect(screen.getByTestId('task-comparison-create')).toBeDisabled()
  })
})
