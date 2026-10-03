import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, expect, test, vi } from 'vitest'
import { ComputerUseSubmit } from './ComputerUseSubmit'
import { requestLocalExecutor } from '@/tauri/localExecutor'
vi.mock('@/hooks/useTranslation', () => ({ useTranslation: () => ({ t: (key: string) => key }) }))
vi.mock('@/tauri/localExecutor', () => ({ requestLocalExecutor: vi.fn() }))
beforeEach(() => {
  vi.mocked(requestLocalExecutor).mockReset()
})
test('pending checks can be cancelled and late results cannot approve a reopened dialog', async () => {
  let resolveFirst!: (value: { canControl: boolean }) => void
  let resolveSecond!: (value: { canControl: boolean }) => void
  const first = new Promise<{ canControl: boolean }>(resolve => {
    resolveFirst = resolve
  })
  const second = new Promise<{ canControl: boolean }>(resolve => {
    resolveSecond = resolve
  })
  vi.mocked(requestLocalExecutor).mockReturnValueOnce(first).mockReturnValueOnce(second)
  const confirm = vi.fn()
  render(<ComputerUseSubmit serverId="local" prompt="test" disabled={false} onConfirm={confirm} />)
  fireEvent.click(screen.getByTestId('computer-use-submit'))
  expect(screen.getByTestId('computer-use-cancel')).toBeEnabled()
  fireEvent.click(screen.getByTestId('computer-use-cancel'))
  expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
  fireEvent.click(screen.getByTestId('computer-use-submit'))
  await act(async () => resolveFirst({ canControl: true }))
  expect(screen.getByTestId('computer-use-confirm')).toBeDisabled()
  expect(screen.getByText('computerUse.checking')).toBeInTheDocument()
  await act(async () => resolveSecond({ canControl: false }))
  expect(screen.getByText('computerUse.unavailable')).toBeInTheDocument()
  expect(screen.getByTestId('computer-use-confirm')).toBeDisabled()
  expect(confirm).not.toHaveBeenCalled()
})
test('checks exact target and confirms only this prompt', async () => {
  vi.mocked(requestLocalExecutor).mockResolvedValue({ canControl: true })
  const confirm = vi.fn()
  render(
    <ComputerUseSubmit serverId="local" prompt="test task" disabled={false} onConfirm={confirm} />
  )
  fireEvent.click(screen.getByTestId('computer-use-submit'))
  await waitFor(() => expect(screen.getByTestId('computer-use-confirm')).toBeEnabled())
  expect(requestLocalExecutor).toHaveBeenCalledWith('runtime.computerUse.status', {
    serverId: 'local',
  })
  fireEvent.click(screen.getByTestId('computer-use-confirm'))
  expect(confirm).toHaveBeenCalledOnce()
  expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
})
test('unavailable desktop cannot be approved and cancelling does not submit', async () => {
  vi.mocked(requestLocalExecutor).mockResolvedValue({ canControl: false })
  const confirm = vi.fn()
  render(<ComputerUseSubmit serverId="local" prompt="test" disabled={false} onConfirm={confirm} />)
  fireEvent.click(screen.getByTestId('computer-use-submit'))
  await screen.findByText('computerUse.unavailable')
  expect(screen.getByTestId('computer-use-confirm')).toBeDisabled()
  fireEvent.click(screen.getByRole('button', { name: 'computerUse.cancel' }))
  expect(confirm).not.toHaveBeenCalled()
})
test('editing the task invalidates the open approval snapshot', async () => {
  vi.mocked(requestLocalExecutor).mockResolvedValue({ canControl: true })
  const props = { serverId: 'local', disabled: false, onConfirm: vi.fn() }
  const { rerender } = render(<ComputerUseSubmit {...props} prompt="first" />)
  fireEvent.click(screen.getByTestId('computer-use-submit'))
  await waitFor(() => expect(screen.getByTestId('computer-use-confirm')).toBeEnabled())
  rerender(<ComputerUseSubmit {...props} prompt="changed" />)
  expect(screen.getByTestId('computer-use-confirm')).toBeDisabled()
})

test('opening or cancelling approval never submits the surrounding composer form', async () => {
  vi.mocked(requestLocalExecutor).mockResolvedValue({ canControl: false })
  const submit = vi.fn((event: React.FormEvent) => event.preventDefault())
  render(
    <form onSubmit={submit}>
      <ComputerUseSubmit serverId="local" prompt="test" disabled={false} onConfirm={vi.fn()} />
    </form>
  )
  fireEvent.click(screen.getByTestId('computer-use-submit'))
  await screen.findByText('computerUse.unavailable')
  expect(submit).not.toHaveBeenCalled()
  fireEvent.click(screen.getByRole('button', { name: 'computerUse.cancel' }))
  expect(submit).not.toHaveBeenCalled()
})

test('existing MCP choice is explained without granting or submitting control', async () => {
  vi.mocked(requestLocalExecutor).mockResolvedValue({
    canControl: false,
    reason: 'existing_windows_mcp_requires_choice',
  })
  const confirm = vi.fn()
  render(
    <ComputerUseSubmit
      serverId="local"
      prompt="keep this task"
      disabled={false}
      onConfirm={confirm}
    />
  )
  fireEvent.click(screen.getByTestId('computer-use-submit'))
  await screen.findByText('computerUse.existingMcp')
  expect(screen.getByTestId('computer-use-confirm')).toBeDisabled()
  expect(screen.getByText('keep this task')).toBeInTheDocument()
  fireEvent.click(screen.getByTestId('computer-use-cancel'))
  expect(confirm).not.toHaveBeenCalled()
})

test('approved session can revoke while busy without running another availability check', async () => {
  const { computerUseConsent } = await import('@/kcoder/computerUseConsent')
  computerUseConsent.set('local-revoke', 'task', true)
  const revoke = vi.fn()
  render(
    <ComputerUseSubmit
      serverId="local-revoke"
      taskId="task"
      prompt=""
      disabled
      onRevoke={revoke}
      onConfirm={vi.fn()}
    />
  )
  expect(screen.getByTestId('computer-use-submit')).toBeEnabled()
  fireEvent.click(screen.getByTestId('computer-use-submit'))
  expect(computerUseConsent.has('local-revoke', 'task')).toBe(false)
  expect(revoke).toHaveBeenCalledOnce()
  expect(requestLocalExecutor).not.toHaveBeenCalled()
})

test('an unresponsive preflight exits checking state and remains cancellable', async () => {
  vi.useFakeTimers()
  try {
    vi.mocked(requestLocalExecutor).mockReturnValue(new Promise(() => {}))
    render(
      <ComputerUseSubmit serverId="timeout" prompt="task" disabled={false} onConfirm={vi.fn()} />
    )
    fireEvent.click(screen.getByTestId('computer-use-submit'))
    await act(() => vi.advanceTimersByTimeAsync(10000))
    expect(screen.getByRole('alert')).toHaveTextContent('computerUse.checkFailed')
    expect(screen.queryByTestId('computer-use-checking')).not.toBeInTheDocument()
    expect(screen.getByTestId('computer-use-confirm')).toBeDisabled()
    fireEvent.click(screen.getByTestId('computer-use-cancel'))
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
  } finally {
    vi.useRealTimers()
  }
})
