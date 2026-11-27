import { installTestTransport, clearTestTransports } from '@/test/runtime-transport'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { AuthProvider } from './AuthProvider'
import { useAuth } from './useAuth'

function Probe() {
  const { user, logout } = useAuth()
  return <button onClick={logout}>{user?.user_name ?? 'none'}</button>
}

function markGateway() {
  const meta = document.createElement('meta')
  meta.name = 'kcoder-rpc-token'
  meta.content = 'cookie-auth'
  document.head.appendChild(meta)
}

describe('AuthProvider', () => {
  beforeEach(() => {
    localStorage.clear()
    sessionStorage.clear()
    window.history.pushState({}, '', '/settings/access-links')
  })

  afterEach(() => {
    clearTestTransports()
    delete window.__KCODER_STUDIO_RUNTIME_CONFIG__
    document.head.querySelector('meta[name="kcoder-rpc-token"]')?.remove()
    document.body.querySelector('form[action$="/logout"]')?.remove()
    vi.restoreAllMocks()
  })

  test('does not start legacy auth on a standalone renderer even with a stale token', () => {
    localStorage.setItem('auth_token', 'stale')
    const fetch = vi.spyOn(globalThis, 'fetch')
    render(<AuthProvider><Probe /></AuthProvider>)

    expect(screen.getByRole('button', { name: 'none' })).toBeInTheDocument()
    expect(window.location.pathname).toBe('/settings/access-links')
    expect(fetch).not.toHaveBeenCalled()
  })

  test('accepts a Gateway document before runtime transport is available', () => {
    window.__KCODER_STUDIO_RUNTIME_CONFIG__ = { runtimeMode: 'backend' }
    markGateway()
    render(<AuthProvider><Probe /></AuthProvider>)

    expect(screen.getByRole('button', { name: 'local' })).toBeInTheDocument()
    expect(window.location.pathname).toBe('/settings/access-links')
  })

  test('logs out using the Gateway route under the public base path', async () => {
    window.__KCODER_STUDIO_RUNTIME_CONFIG__ = { appBasePath: '/g/example' }
    markGateway()
    const submit = vi.spyOn(HTMLFormElement.prototype, 'submit').mockImplementation(() => {})
    render(<AuthProvider><Probe /></AuthProvider>)

    await userEvent.click(screen.getByRole('button', { name: 'local' }))

    expect(submit).toHaveBeenCalledOnce()
    expect(document.querySelector('form')).toHaveAttribute('action', '/g/example/logout')
  })

  test('supports the local runtime transport without Gateway HTML', () => {
    installTestTransport(() => null)
    render(<AuthProvider><Probe /></AuthProvider>)
    expect(screen.getByRole('button', { name: 'local' })).toBeInTheDocument()
  })
})
