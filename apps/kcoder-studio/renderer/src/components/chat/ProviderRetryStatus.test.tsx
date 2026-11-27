import { act, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, expect, test, vi } from 'vitest'
import '@/i18n'
import { ProviderRetryStatus } from './ProviderRetryStatus'
import { providerRetryDiagnostics } from '@/kcoder/providerRetryDiagnostics'
import { RetainedPageActive } from '@/components/layout/retainedPageState'
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks() })

test('details open only on click and distinguish the previous failure from observed current progress', async () => {
  vi.useFakeTimers()
  vi.setSystemTime(1000)
  render(
    <ProviderRetryStatus
      activity={{
        attempt: 1,
        maxRetries: 3,
        retryAfterMs: 2000,
        receivedAtMs: 1000,
        diagnostics: {
          reason: 'network_error',
          provider: 'Baize',
          model: 'owned-model',
          previousAttemptElapsedMs: 1200,
          timeoutKind: 'transport_timeout',
        },
      }}
    />
  )
  expect(screen.queryByTestId('provider-retry-details')).not.toBeInTheDocument()
  expect(screen.getByTestId('provider-retry-details-toggle')).toHaveAttribute(
    'aria-expanded',
    'false'
  )
  fireEvent.click(screen.getByTestId('provider-retry-details-toggle'))
  expect(screen.getByTestId('provider-retry-details')).toHaveTextContent('network_error')
  expect(screen.getByTestId('provider-retry-details')).toHaveTextContent('上次失败尝试')
  await act(async () => {
    await vi.advanceTimersByTimeAsync(2000)
  })
  expect(screen.getByTestId('provider-retry-status')).toHaveTextContent(
    '退避倒计时已结束，等待请求进展'
  )
  expect(screen.getByTestId('provider-retry-details')).toHaveTextContent('尚未观察到新的请求进展')
  expect(screen.getByTestId('provider-retry-details')).toHaveTextContent('1200')
  await act(async () => {
    await vi.advanceTimersByTimeAsync(100000)
  })
  expect(screen.getByTestId('provider-retry-status')).toBeInTheDocument()
  expect(screen.getByTestId('provider-retry-details')).toHaveTextContent('1200')
})
test('malicious metadata is plain text and sensitive values never mount in expanded details', () => {
  const diagnostics = providerRetryDiagnostics({
    reason: '<img src=x onerror=alert(1)> api_key=OWNED_SECRET',
    provider: 'OwnedProvider',
    model: 'https://user:PRIVATE@owned.invalid/model?token=PRIVATE_TOKEN',
  })
  const { container } = render(
    <ProviderRetryStatus
      activity={{
        attempt: 1,
        maxRetries: 2,
        retryAfterMs: 0,
        receivedAtMs: Date.now(),
        diagnostics,
      }}
    />
  )
  fireEvent.click(screen.getByTestId('provider-retry-details-toggle'))
  expect(container.querySelector('img')).toBeNull()
  expect(screen.getByTestId('provider-retry-details')).not.toHaveTextContent(
    /OWNED_SECRET|PRIVATE_TOKEN|user:PRIVATE/
  )
  expect(screen.getByTestId('provider-retry-details')).toHaveTextContent('[REDACTED]')
})

test('reopening an elapsed backoff never briefly displays the original countdown', () => {
  vi.useFakeTimers()
  vi.setSystemTime(20000)
  render(
    <ProviderRetryStatus
      activity={{ attempt: 2, maxRetries: 3, retryAfterMs: 2000, receivedAtMs: 1000 }}
    />
  )
  expect(screen.getByTestId('provider-retry-status')).toHaveAttribute('data-state', 'retrying')
  expect(screen.getByTestId('provider-retry-status')).not.toHaveTextContent('2 秒后重试')
})

test.each(['retained', 'browser'] as const)('%s hiding suspends the countdown and preserves disclosure across its original deadline', boundary => {
  vi.useFakeTimers()
  vi.setSystemTime(1000)
  const visibility = vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('visible')
  let open = true
  const activity = { attempt: 1, maxRetries: 3, retryAfterMs: 10_000, receivedAtMs: 1000 }
  const view = render(<ProviderRetryStatus activity={activity} />, {
    wrapper: ({ children }) => <RetainedPageActive.Provider value={open}>{children}</RetainedPageActive.Provider>,
  })
  fireEvent.click(screen.getByTestId('provider-retry-details-toggle'))
  const show = (visible: boolean) => act(() => {
    if (boundary === 'retained') open = visible
    else visibility.mockReturnValue(visible ? 'visible' : 'hidden')
    view.rerender(<ProviderRetryStatus activity={activity} />)
    document.dispatchEvent(new Event('visibilitychange'))
  })
  show(false)
  expect(vi.getTimerCount()).toBe(0)
  const displayed = screen.getByTestId('provider-retry-status').textContent
  act(() => { vi.advanceTimersByTime(20_000) })
  expect(screen.getByTestId('provider-retry-status').textContent).toBe(displayed)
  expect(vi.getTimerCount()).toBe(0)
  show(true)
  expect(screen.getByTestId('provider-retry-status')).toHaveAttribute('data-state', 'retrying')
  expect(screen.getByTestId('provider-retry-details-toggle')).toHaveAttribute('aria-expanded', 'true')
  expect(vi.getTimerCount()).toBe(0)
  view.unmount()
})

test('a replacement retry uses its own fractional deadline and stops ticking after expiry', () => {
  vi.useFakeTimers()
  vi.setSystemTime(1000)
  const view = render(<ProviderRetryStatus activity={{ attempt: 1, maxRetries: 3, retryAfterMs: 5000, receivedAtMs: 1000 }} />)
  act(() => { vi.advanceTimersByTime(1000) })
  view.rerender(<ProviderRetryStatus activity={{ attempt: 2, maxRetries: 3, retryAfterMs: 1250, receivedAtMs: 2000 }} />)
  act(() => { vi.advanceTimersByTime(1249) })
  expect(screen.getByTestId('provider-retry-status')).toHaveAttribute('data-state', 'waiting')
  act(() => { vi.advanceTimersByTime(1) })
  expect(screen.getByTestId('provider-retry-status')).toHaveAttribute('data-state', 'retrying')
  expect(vi.getTimerCount()).toBe(0)
  view.unmount()
})
