import { expect, test } from 'vitest'
import { proxyDisplayUrl, proxyTargetHosts } from './pluginProxyDiagnostics'

test('proxy diagnostics omit credentials paths query strings and malformed destinations', () => {
  expect(proxyDisplayUrl('socks5h://user:secret@[::1]:61234/private?token=secret')).toBe(
    'socks5h://[::1]:61234'
  )
  expect(proxyDisplayUrl('http://127.0.0.1:32123/')).toBe('http://127.0.0.1:32123')
  expect(proxyDisplayUrl('file:///private/secret')).toBe('')
  expect(proxyDisplayUrl(null)).toBe('')
  expect(
    proxyTargetHosts([
      'https://user:secret@source.test/private?token=secret',
      'https://source.test/',
      'https://redirect.test:8443/path',
      'http://insecure.test/',
      'not-a-url',
    ])
  ).toEqual(['source.test', 'redirect.test:8443'])
})
