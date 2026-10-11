import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, expect, test, vi } from 'vitest'
import { KCoderAccountLogin } from './KCoderAccountLogin'

const login = vi.hoisted(() => vi.fn())
const logout = vi.hoisted(() => vi.fn())
const autoLogin = vi.hoisted(() => vi.fn())
const deviceId = vi.hoisted(() => vi.fn(() => 'device-fixture-uuid'))
vi.mock('@/kcoder/gatewayRpc', () => ({
  loginGatewayAccount: login,
  logoutGatewayAccount: logout,
  autoLoginGatewayAccount: autoLogin,
  getAccountDeviceId: deviceId,
}))
vi.mock('@/hooks/useTranslation', () => ({ useTranslation: () => ({ t: (key: string) => key }) }))

const anonymousServer = {
  id: 'alice',
  label: 'Alice',
  description: '',
  runtime: 'kcoder' as const,
  transport: 'ssh' as const,
  status: 'offline' as const,
  security: { identity: { mode: 'kcoder-account' as const, username: 'alice' } },
}

const authenticatedServer = {
  ...anonymousServer,
  status: 'online' as const,
  accountIdentity: { principalId: '0b6cfba4-5f61-4d17-9d92-3d60a1ef2f01', username: 'alice', role: 'user' as const },
}

beforeEach(() => {
  login.mockReset()
  logout.mockReset()
  autoLogin.mockReset()
  autoLogin.mockRejectedValue(new Error('no saved login'))
})

test('login sends the editable username plus password and clears password state', async () => {
  login.mockResolvedValue({ authenticated: true })
  const changed = vi.fn().mockResolvedValue(undefined)
  render(<KCoderAccountLogin server={anonymousServer} onChanged={changed} />)
  fireEvent.change(screen.getByTestId('kcoder-account-username'), { target: { value: 'alice' } })
  fireEvent.change(screen.getByTestId('kcoder-account-password'), {
    target: { value: 'private-fixture-password' },
  })
  fireEvent.click(screen.getByTestId('kcoder-account-submit'))
  await waitFor(() => expect(changed).toHaveBeenCalledOnce())
  expect(login).toHaveBeenCalledWith('alice', {
    username: 'alice',
    password: 'private-fixture-password',
    deviceId: 'device-fixture-uuid',
  })
  expect(screen.getByTestId('kcoder-account-password')).toHaveValue('')
})

test('the username input is editable and defaults to the stored hint', () => {
  render(<KCoderAccountLogin server={anonymousServer} onChanged={vi.fn()} />)
  const input = screen.getByTestId('kcoder-account-username') as HTMLInputElement
  expect(input.value).toBe('alice')
  expect(input.readOnly).toBe(false)
  expect(input.disabled).toBe(false)
})

test('a failed account login stays on the page and never reports success', async () => {
  login.mockRejectedValue(new Error('Account denied'))
  const changed = vi.fn()
  render(<KCoderAccountLogin server={anonymousServer} onChanged={changed} />)
  fireEvent.change(screen.getByTestId('kcoder-account-username'), { target: { value: 'alice' } })
  fireEvent.change(screen.getByTestId('kcoder-account-password'), {
    target: { value: 'private-fixture-password' },
  })
  fireEvent.click(screen.getByTestId('kcoder-account-submit'))
  expect(await screen.findByRole('alert')).toHaveTextContent('Account denied')
  expect(changed).not.toHaveBeenCalled()
})

test('an anonymous target attempts one silent auto-restore on mount', async () => {
  const changed = vi.fn().mockResolvedValue(undefined)
  render(<KCoderAccountLogin server={anonymousServer} onChanged={changed} />)
  await waitFor(() => expect(autoLogin).toHaveBeenCalledOnce())
  expect(autoLogin).toHaveBeenCalledWith('alice', 'device-fixture-uuid')
  expect(changed).not.toHaveBeenCalled()
})

test('logout requires confirmation and clears the remembered credential', async () => {
  logout.mockResolvedValue(undefined)
  const changed = vi.fn().mockResolvedValue(undefined)
  const view = render(<KCoderAccountLogin server={authenticatedServer} onChanged={changed} />)
  fireEvent.click(screen.getByTestId('kcoder-account-logout'))
  fireEvent.click(screen.getByTestId('kcoder-account-confirm-logout'))
  await waitFor(() => expect(changed).toHaveBeenCalledOnce())
  expect(logout).toHaveBeenCalledWith('alice', 'device-fixture-uuid')
  // After the server list reloads without the identity, the login form
  // returns with an editable username.
  view.rerender(<KCoderAccountLogin server={anonymousServer} onChanged={changed} />)
  expect(screen.getByTestId('kcoder-account-username')).toBeTruthy()
})

test('switch confirms first and returns to the login form without calling login', async () => {
  logout.mockResolvedValue(undefined)
  const changed = vi.fn().mockResolvedValue(undefined)
  const view = render(<KCoderAccountLogin server={authenticatedServer} onChanged={changed} />)
  fireEvent.click(screen.getByTestId('kcoder-account-switch'))
  expect(screen.getByText('accounts.switchWarning')).toBeTruthy()
  fireEvent.click(screen.getByTestId('kcoder-account-confirm-logout'))
  await waitFor(() => expect(logout).toHaveBeenCalledOnce())
  expect(login).not.toHaveBeenCalled()
  view.rerender(<KCoderAccountLogin server={anonymousServer} onChanged={changed} />)
  expect(screen.getByTestId('kcoder-account-username')).toBeTruthy()
})
