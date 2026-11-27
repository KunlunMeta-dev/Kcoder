import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, test, vi } from 'vitest'
import App from './App'

const authState = vi.hoisted(() => ({ isLoading: false }))

vi.mock('@/features/auth/AuthProvider', () => ({
  AuthProvider: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}))

vi.mock('@/features/auth/useAuth', () => ({
  useAuth: () => ({
    user: null,
    isLoading: authState.isLoading,
    logout: vi.fn(),
  }),
}))

describe('App auth routing', () => {
  afterEach(() => {
    cleanup()
    authState.isLoading = false
  })

  test('shows the Gateway entry instructions on a retired renderer login path', async () => {
    window.history.pushState({}, '', '/login')

    render(<App />)

    expect(await screen.findByTestId('studio-gateway-required')).toBeInTheDocument()
    expect(screen.queryByTestId('login-form')).not.toBeInTheDocument()
  })

  test('shows a full-screen loading state during browser authentication', () => {
    authState.isLoading = true
    window.history.pushState({}, '', '/')

    render(<App />)

    expect(screen.getByTestId('page-loading-state')).toHaveClass('kcoder-page-loading-screen')
    expect(screen.getByRole('status')).toHaveTextContent('加载中')
  })
})
