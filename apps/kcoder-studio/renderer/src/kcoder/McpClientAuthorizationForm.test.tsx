import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { expect, test, vi } from 'vitest'
import '@/i18n'
import { McpClientAuthorizationForm } from './McpClientAuthorizationForm'

test('submits explicit credentials and scopes while clearing the password input', async () => {
  const authorize = vi.fn().mockResolvedValue(undefined)
  render(<McpClientAuthorizationForm disabled={false} authorize={authorize} />)
  fireEvent.click(screen.getByText(/Advanced authorization options|高级授权选项/))
  fireEvent.change(screen.getByLabelText(/Client ID|客户端 ID/), {
    target: { value: 'registered-client' },
  })
  fireEvent.change(screen.getByLabelText(/Client authentication|客户端认证方式/), {
    target: { value: 'client_secret_basic' },
  })
  const secret = screen.getByLabelText(/Client secret|客户端密钥/)
  fireEvent.change(secret, { target: { value: 'fixture-client-secret' } })
  fireEvent.change(screen.getByLabelText(/Scopes|授权范围/), { target: { value: 'read write' } })
  fireEvent.click(screen.getByRole('button', { name: /Authorize|授权登录/ }))
  await waitFor(() =>
    expect(authorize).toHaveBeenCalledWith({
      clientId: 'registered-client',
      clientAuthentication: 'client_secret_basic',
      clientSecret: 'fixture-client-secret',
      scopes: ['read', 'write'],
    })
  )
  expect(secret).toHaveValue('')
})

test('automatic registration sends scopes without inventing a client identity', async () => {
  const authorize = vi.fn().mockResolvedValue(undefined)
  render(<McpClientAuthorizationForm disabled={false} authorize={authorize} />)
  fireEvent.click(screen.getByText(/Advanced authorization options|高级授权选项/))
  fireEvent.click(screen.getByRole('button', { name: /Authorize|授权登录/ }))
  await waitFor(() => expect(authorize).toHaveBeenCalledWith({ scopes: [] }))
})
