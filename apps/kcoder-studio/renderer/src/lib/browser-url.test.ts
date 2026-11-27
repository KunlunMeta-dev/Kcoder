import { describe, expect, test } from 'vitest'
import { normalizeBrowserUrl } from './browser-url'

describe('browser URL helpers', () => {
  test('normalizes supported browser URLs', () => {
    expect(normalizeBrowserUrl('example.test')).toBe('https://example.test/')
    expect(normalizeBrowserUrl('https://example.test/mygroups?gid=1')).toBe(
      'https://example.test/mygroups?gid=1'
    )
    expect(normalizeBrowserUrl('ftp://example.com')).toBeNull()
  })

  test('rejects retired application schemes even when the origin matches', () => {
    expect(
      normalizeBrowserUrl(
        'retired-app://localhost/extension-page.html?sessionId=123e4567-e89b-42d3-a456-426614174000',
        'retired-app://localhost/'
      )
    ).toBeNull()
    expect(
      normalizeBrowserUrl('retired-app://other-host/extension-page.html', 'retired-app://localhost/')
    ).toBe(null)
    expect(
      normalizeBrowserUrl('custom://localhost/extension-page.html', 'retired-app://localhost/')
    ).toBe(null)
  })

  test('rejects retired native asset protocol URLs', () => {
    expect(normalizeBrowserUrl('asset://localhost/Users/me/workspace/chart.html')).toBeNull()
    expect(normalizeBrowserUrl('asset://other-host/Users/me/workspace/chart.html')).toBeNull()
  })
})
