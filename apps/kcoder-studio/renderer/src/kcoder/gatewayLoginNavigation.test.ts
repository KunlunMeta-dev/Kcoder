import { describe, expect, test } from 'vitest'
import { gatewayLoginUrl } from './gatewayLoginNavigation'

describe('gateway login navigation', () => {
  test('preserves only a same-origin absolute return path', () => {
    expect(gatewayLoginUrl({ pathname: '/settings/connections', search: '?tab=targets' })).toBe(
      '/login?returnTo=%2Fsettings%2Fconnections%3Ftab%3Dtargets'
    )
    expect(gatewayLoginUrl({ pathname: '/login', search: '' })).toBe('/login')
    expect(gatewayLoginUrl({ pathname: '//evil.example', search: '' })).toBe('/login')
  })
})
