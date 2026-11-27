import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, expect, test, vi } from 'vitest'
import { KCoderAccountOidc } from './KCoderAccountOidc'

const calls = vi.hoisted(() => ({ start: vi.fn(), read: vi.fn(), cancel: vi.fn(), open: vi.fn() }))
vi.mock('@/kcoder/gatewayAccountOidc', () => ({
  startGatewayAccountOidc: calls.start,
  readGatewayAccountOidc: calls.read,
  cancelGatewayAccountOidc: calls.cancel,
}))
vi.mock('@/lib/external-links', () => ({ openExternalUrl: calls.open }))
vi.mock('@/hooks/useTranslation', () => ({
  useTranslation: () => ({ t: (key: string) => key, i18n: { language: 'en' } }),
}))
beforeEach(() => {
  Object.values(calls).forEach(call => call.mockReset())
  calls.cancel.mockResolvedValue({ status: 'failed' })
  calls.open.mockResolvedValue(true)
})

test('organization sign-in opens only its fixed HTTPS challenge and completes the original target', async () => {
  calls.start.mockImplementation((_target, _username, id) =>
    Promise.resolve({
      clientRequestId: id,
      authorizationUrl: 'https://issuer.test/auth',
      expiresIn: 180,
    })
  )
  calls.read.mockResolvedValue({ status: 'authenticated' })
  const changed = vi.fn().mockResolvedValue(undefined),
    busy = vi.fn()
  render(
    <KCoderAccountOidc
      serverId="original"
      username="alice"
      disabled={false}
      onBusy={busy}
      onChanged={changed}
    />
  )
  fireEvent.click(screen.getByTestId('kcoder-account-sso-start'))
  await waitFor(() => expect(changed).toHaveBeenCalledOnce())
  expect(calls.open).toHaveBeenCalledWith('https://issuer.test/auth', { target: 'system' })
  expect(calls.start.mock.calls[0].slice(0, 2)).toEqual(['original', 'alice'])
  expect(calls.cancel).not.toHaveBeenCalled()
})

test('switching target cancels only the original client request and ignores its late challenge', async () => {
  let resolve: (value: unknown) => void = () => {}
  calls.start.mockImplementation(
    () =>
      new Promise(done => {
        resolve = done
      })
  )
  const busy = vi.fn(),
    changed = vi.fn()
  const mounted = render(
    <KCoderAccountOidc
      serverId="old"
      username="alice"
      disabled={false}
      onBusy={busy}
      onChanged={changed}
    />
  )
  fireEvent.click(screen.getByTestId('kcoder-account-sso-start'))
  const originalId = calls.start.mock.calls[0][2]
  mounted.rerender(
    <KCoderAccountOidc
      serverId="new"
      username="alice"
      disabled={false}
      onBusy={busy}
      onChanged={changed}
    />
  )
  resolve({
    clientRequestId: originalId,
    authorizationUrl: 'https://issuer.test/old',
    expiresIn: 180,
  })
  await waitFor(() => expect(calls.cancel).toHaveBeenCalledWith('old', originalId))
  expect(calls.open).not.toHaveBeenCalled()
  expect(changed).not.toHaveBeenCalled()
})
