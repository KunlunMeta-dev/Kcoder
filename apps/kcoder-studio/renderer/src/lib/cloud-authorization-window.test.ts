import { expect, test, vi } from 'vitest'
import { openExternalUrl } from './external-links'
import { openCloudAuthorizationWindow } from './cloud-authorization-window'
vi.mock('./external-links', async original => ({
  ...(await original<typeof import('./external-links')>()),
  openExternalUrl: vi.fn(),
}))
test('opens authorization with the same external-browser policy as other links', async () => {
  await openCloudAuthorizationWindow('https://example.test/authorize')
  expect(openExternalUrl).toHaveBeenCalledWith('https://example.test/authorize')
  vi.mocked(openExternalUrl).mockClear()
  await openCloudAuthorizationWindow('javascript:alert(1)')
  expect(openExternalUrl).not.toHaveBeenCalled()
})
