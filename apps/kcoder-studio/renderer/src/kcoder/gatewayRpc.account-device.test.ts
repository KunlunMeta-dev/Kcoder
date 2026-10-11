import { afterEach, expect, test, vi } from 'vitest'

const key = 'kcoder.account.deviceId'
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/

function insecureHttpCrypto() {
  let issued = 0
  const getRandomValues = vi.fn((bytes: Uint8Array) => {
    bytes.fill(++issued)
    return bytes
  })
  vi.stubGlobal('crypto', { getRandomValues })
  return getRandomValues
}

afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
  window.localStorage.removeItem(key)
  vi.resetModules()
})

test('LAN HTTP without randomUUID creates and retains the persisted browser device ID', async () => {
  window.localStorage.removeItem(key)
  const getRandomValues = insecureHttpCrypto()
  vi.resetModules()
  const { getAccountDeviceId } = await import('./gatewayRpc')
  const created = getAccountDeviceId()
  expect(created).toMatch(uuid)
  expect(getAccountDeviceId()).toBe(created)
  expect(window.localStorage.getItem(key)).toBe(created)
  expect(getRandomValues).toHaveBeenCalledTimes(1)
})

test.each(['getItem', 'setItem'] as const)(
  'blocked Storage.%s keeps an ID within one page and separates a fresh page runtime',
  async method => {
    window.localStorage.removeItem(key)
    const getRandomValues = insecureHttpCrypto()
    vi.spyOn(Storage.prototype, method).mockImplementation(() => {
      throw new DOMException('Storage is restricted', 'SecurityError')
    })
    vi.resetModules()
    const firstPage = await import('./gatewayRpc')
    const first = firstPage.getAccountDeviceId()
    expect(first).toMatch(uuid)
    expect(firstPage.getAccountDeviceId()).toBe(first)
    vi.resetModules()
    const secondPage = await import('./gatewayRpc')
    const second = secondPage.getAccountDeviceId()
    expect(second).toMatch(uuid)
    expect(second).not.toBe(first)
    expect(secondPage.getAccountDeviceId()).toBe(second)
    expect(getRandomValues).toHaveBeenCalledTimes(2)
  }
)

test('an existing real stored device ID is preserved without generating or writing another', async () => {
  window.localStorage.setItem(key, 'existing-browser-device-id')
  const getRandomValues = insecureHttpCrypto()
  const write = vi.spyOn(Storage.prototype, 'setItem')
  vi.resetModules()
  const { getAccountDeviceId } = await import('./gatewayRpc')
  expect(getAccountDeviceId()).toBe('existing-browser-device-id')
  expect(getAccountDeviceId()).toBe('existing-browser-device-id')
  expect(getRandomValues).not.toHaveBeenCalled()
  expect(write).not.toHaveBeenCalled()
})
