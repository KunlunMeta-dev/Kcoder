import { afterEach, describe, expect, test } from 'vitest'
import { gatewayLoginUrl } from './gatewayLoginNavigation'

describe('gateway login navigation', () => {
  afterEach(() => {
    document.head.innerHTML = ''
  })

  test('keeps login and its return path inside the relay mount', () => {
    const base = document.createElement('meta')
    base.name = 'kcoder-app-base-path'
    base.content = '/g/owned-gateway'
    document.head.appendChild(base)
    expect(gatewayLoginUrl({ pathname: '/g/owned-gateway/settings', search: '' })).toBe(
      '/g/owned-gateway/login?returnTo=%2Fg%2Fowned-gateway%2Fsettings'
    )
    expect(gatewayLoginUrl({ pathname: '/g/owned-gateway/login', search: '' })).toBe(
      '/g/owned-gateway/login'
    )
  })

  test('preserves only a same-origin absolute return path', () => {
    expect(gatewayLoginUrl({ pathname: '/settings/connections', search: '?tab=targets' })).toBe(
      '/login?returnTo=%2Fsettings%2Fconnections%3Ftab%3Dtargets'
    )
    expect(gatewayLoginUrl({ pathname: '/login', search: '' })).toBe('/login')
    expect(gatewayLoginUrl({ pathname: '//evil.example', search: '' })).toBe('/login')
  })
})
