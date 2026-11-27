import { afterEach, describe, expect, test, vi } from 'vitest'
import { fireEvent, waitFor } from '@testing-library/react'
import {
  installExternalLinkHandler,
  isHttpUrl,
  isLocalHttpUrl,
  openExternalUrl,
} from './external-links'
const openWindowMock = vi.fn()

afterEach(() => {
  document.body.innerHTML = ''
  openWindowMock.mockReset()
  vi.unstubAllGlobals()
})

describe('external link helpers', () => {
  test('accepts only http and https URLs', () => {
    expect(isHttpUrl('https://example.com')).toBe(true)
    expect(isHttpUrl('http://example.com')).toBe(true)
    expect(isHttpUrl('mailto:user@example.com')).toBe(false)
    expect(isHttpUrl('/settings')).toBe(false)
    expect(isHttpUrl('javascript:alert(1)')).toBe(false)
  })

  test('detects localhost URLs without treating private remote hosts as local', () => {
    expect(isLocalHttpUrl('http://localhost:3000')).toBe(true)
    expect(isLocalHttpUrl('https://app.localhost/path')).toBe(true)
    expect(isLocalHttpUrl('http://127.0.0.1:5173')).toBe(true)
    expect(isLocalHttpUrl('http://[::1]:8000')).toBe(true)
    expect(isLocalHttpUrl('http://192.168.1.20')).toBe(false)
    expect(isLocalHttpUrl('https://example.com')).toBe(false)
  })

  test('opens http URLs through the browser/Electron navigation policy', async () => {
    vi.stubGlobal('open', openWindowMock)

    await expect(openExternalUrl('https://example.com/docs')).resolves.toBe(true)

    expect(openWindowMock).toHaveBeenCalledWith(
      'https://example.com/docs',
      '_blank',
      'noopener,noreferrer'
    )
  })

  test('intercepts clicked http anchors through the shared opener', async () => {
    vi.stubGlobal('open', openWindowMock)
    const cleanup = installExternalLinkHandler()
    document.body.innerHTML = '<a href="https://example.com/path">Open</a>'

    fireEvent.click(document.querySelector('a')!)

    await waitFor(() =>
      expect(openWindowMock).toHaveBeenCalledWith(
        'https://example.com/path',
        '_blank',
        'noopener,noreferrer'
      )
    )
    cleanup()
  })
})
