import { act, fireEvent, render, screen } from '@testing-library/react'
import { expect, test, vi } from 'vitest'
import { ComputerUseRecovery, type ComputerUseRecoveryFacts } from './ComputerUseRecovery'
vi.mock('@/hooks/useTranslation', () => ({ useTranslation: () => ({ t: (key: string) => key }) }))
const facts: ComputerUseRecoveryFacts = {
  authorization: 'valid',
  channel: 'unavailable',
  cleanup: 'unknown',
  failureCode: 'connection_lost',
  operationId: 'op-7',
  tool: 'Click',
  elapsedMs: 1200,
}

test('shows independent host facts and serializes recovery for the observed old turn', async () => {
  let finish!: () => void
  const onRecover = vi.fn(
    () =>
      new Promise<void>(resolve => {
        finish = resolve
      })
  )
  render(
    <ComputerUseRecovery turnId="old-turn" facts={facts} recoveryAvailable onRecover={onRecover} />
  )
  expect(screen.getByTestId('computer-use-authorization')).toHaveTextContent('authorization.valid')
  expect(screen.getByTestId('computer-use-channel')).toHaveTextContent('channel.unavailable')
  expect(screen.getByTestId('computer-use-cleanup')).toHaveTextContent('cleanup.unknown')
  const button = screen.getByTestId('computer-use-recover')
  fireEvent.click(button)
  fireEvent.click(button)
  expect(onRecover).toHaveBeenCalledExactlyOnceWith('old-turn')
  expect(button).toBeDisabled()
  expect(screen.getByRole('status')).toHaveTextContent('computerUse.recovery.observeFirst')
  await act(async () => finish())
  expect(button).toBeDisabled()
})

test('revoked, unknown authorization, available channel and unsupported peers cannot recover', () => {
  const onRecover = vi.fn(async () => {})
  const { rerender } = render(
    <ComputerUseRecovery
      turnId="old-turn"
      facts={facts}
      recoveryAvailable={false}
      onRecover={onRecover}
    />
  )
  expect(screen.queryByTestId('computer-use-recover')).not.toBeInTheDocument()
  for (const update of [
    { authorization: 'revoked' },
    { authorization: 'unknown' },
    { channel: 'available' },
  ] as Partial<ComputerUseRecoveryFacts>[]) {
    rerender(
      <ComputerUseRecovery
        turnId="old-turn"
        facts={{ ...facts, ...update }}
        recoveryAvailable
        onRecover={onRecover}
      />
    )
    expect(screen.queryByTestId('computer-use-recover')).not.toBeInTheDocument()
  }
  expect(onRecover).not.toHaveBeenCalled()
})

test('lost recovery receipt stays unknown and cannot submit a second recovery', async () => {
  const onRecover = vi.fn(async () => {
    throw new Error('private worker details')
  })
  render(
    <ComputerUseRecovery turnId="old-turn" facts={facts} recoveryAvailable onRecover={onRecover} />
  )
  await act(async () => fireEvent.click(screen.getByTestId('computer-use-recover')))
  expect(screen.getByRole('alert')).toHaveTextContent('computerUse.recovery.receiptUnknown')
  fireEvent.click(screen.getByTestId('computer-use-recover'))
  expect(onRecover).toHaveBeenCalledOnce()
  expect(screen.queryByText('private worker details')).not.toBeInTheDocument()
})

test('diagnostics expose only bounded operation metadata and fixed failure/tool codes', () => {
  render(
    <ComputerUseRecovery
      turnId="old-turn"
      facts={{
        ...facts,
        operationId: 'private window title with spaces',
        tool: 'private screenshot',
        failureCode: 'private arbitrary diagnostic',
      }}
      recoveryAvailable={false}
    />
  )
  expect(screen.queryByTestId('computer-use-failure')).not.toBeInTheDocument()
  expect(screen.queryByText('computerUse.recovery.diagnostics')).not.toBeInTheDocument()
  expect(document.body.textContent).not.toContain('private')
})
