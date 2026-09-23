import { render, screen } from '@testing-library/react'
import { afterEach, expect, test, vi } from 'vitest'
import '@/i18n'
import { AppsPage } from './AppsPage'

const createHttpClient = vi.hoisted(() => vi.fn())
vi.mock('@/api/http', () => ({ createHttpClient }))

afterEach(() => {
  document.querySelector('meta[name="kcoder-rpc-token"]')?.remove()
})

test('Gateway does not advertise or request upstream cloud apps and account proxies', () => {
  const meta = document.createElement('meta')
  meta.name = 'kcoder-rpc-token'
  meta.content = 'test-gateway'
  document.head.append(meta)
  render(<AppsPage />)
  expect(screen.getByTestId('gateway-apps-unavailable')).toBeInTheDocument()
  expect(screen.getByTestId('apps-page')).not.toHaveTextContent(/Codex|Wegent|WeWork|Claude/)
  expect(createHttpClient).not.toHaveBeenCalled()
})
