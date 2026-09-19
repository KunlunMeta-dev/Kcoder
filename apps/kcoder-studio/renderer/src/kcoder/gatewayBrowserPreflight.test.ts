import { expect, test, vi } from 'vitest'
import type { GatewayClient } from './gatewayRuntimeTypes'
import { assertRemoteBrowserAvailable } from './gatewayBrowserPreflight'

const client = (diagnostics: boolean) =>
  ({
    supportsExperimental: (name: string) => name === 'browserPreflight' && diagnostics,
    request: vi
      .fn()
      .mockResolvedValue({
        available: false,
        reason: 'Chromium cannot run as root with its sandbox',
      }),
  }) as unknown as GatewayClient

test('surfaces real startup prerequisites instead of claiming the protocol is unsupported', async () => {
  const target = client(true)
  await expect(assertRemoteBrowserAvailable(target)).rejects.toThrow('cannot run as root')
  expect(target.request).toHaveBeenCalledWith('browser/preflight', {})
})

test('allows a refreshed preflight after prerequisites have been repaired', async () => {
  const target = client(true)
  vi.mocked(target.request).mockResolvedValue({ available: true, reason: null })
  await expect(assertRemoteBrowserAvailable(target)).resolves.toBeUndefined()
})

test('keeps older unavailable runtimes closed without requesting unknown diagnostics', async () => {
  const target = client(false)
  await expect(assertRemoteBrowserAvailable(target)).rejects.toThrow(
    'target browser is unavailable'
  )
  expect(target.request).not.toHaveBeenCalled()
})
