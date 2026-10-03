import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, expect, test, vi } from 'vitest'
import { KCoderAccountManagement } from './KCoderAccountManagement'

const manage = vi.hoisted(() => vi.fn())
vi.mock('@/kcoder/gatewayRpc', () => ({ manageGatewayAccounts: manage }))
vi.mock('@/hooks/useTranslation', () => ({ useTranslation: () => ({ t: (key: string) => key }) }))
beforeEach(() => {
  manage.mockReset()
})

test('administrator creates an ordinary account and refreshes the server list', async () => {
  manage.mockResolvedValue([{ id: 'alice-id', username: 'alice', role: 'user', disabled: false }])
  render(<KCoderAccountManagement serverId="remote" />)
  fireEvent.click(screen.getByText('accounts.manage'))
  await screen.findByTestId('kcoder-account-create')
  fireEvent.change(screen.getByTestId('kcoder-account-new-username'), { target: { value: 'bob' } })
  fireEvent.change(screen.getByTestId('kcoder-account-new-password'), {
    target: { value: 'synthetic-account-password' },
  })
  fireEvent.click(screen.getByTestId('kcoder-account-create'))
  await waitFor(() =>
    expect(manage).toHaveBeenCalledWith('remote', {
      operation: 'create',
      username: 'bob',
      password: 'synthetic-account-password',
      role: 'user',
    })
  )
  await waitFor(() => expect(screen.getByTestId('kcoder-account-new-password')).toHaveValue(''))
  expect(screen.getByText('alice · user')).toBeInTheDocument()
})

test('failed account creation clears password and presents a retryable error', async () => {
  manage.mockResolvedValue([])
  render(<KCoderAccountManagement serverId="remote" />)
  fireEvent.click(screen.getByText('accounts.manage'))
  await screen.findByTestId('kcoder-account-create')
  manage.mockRejectedValue(new Error('denied'))
  fireEvent.change(screen.getByTestId('kcoder-account-new-username'), { target: { value: 'bob' } })
  fireEvent.change(screen.getByTestId('kcoder-account-new-password'), {
    target: { value: 'synthetic-account-password' },
  })
  fireEvent.click(screen.getByTestId('kcoder-account-create'))
  expect(await screen.findByRole('alert')).toHaveTextContent('accounts.failed')
  expect(screen.getByTestId('kcoder-account-new-password')).toHaveValue('')
  expect(screen.getByTestId('kcoder-account-create')).not.toBeDisabled()
})
