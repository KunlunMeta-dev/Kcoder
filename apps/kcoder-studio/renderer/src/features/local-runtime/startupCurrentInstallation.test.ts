import { afterEach, expect, test, vi } from 'vitest'
import { importCurrentInstallation, readCurrentInstallation } from './startupCurrentInstallation'
const preview = { token: 'owned-operation', sourceId: 'original', sourceLabel: 'Original', targetId: 'current-owned', command: 'C:\\Owned Current\\kcoder.exe',
  publicationState: 'ready' as const, usesCurrentAccountConfiguration: true, keepsOriginalConnection: true }
afterEach(() => vi.unstubAllGlobals())
test('the non-mutating preview requires the original source and cannot select a mismatched receipt', async () => {
  const fetch = vi.fn().mockResolvedValue(Response.json({ available: true, preview }))
  vi.stubGlobal('fetch', fetch)
  expect(await readCurrentInstallation('original', new AbortController().signal)).toMatchObject({ sourceId: 'original', targetId: 'current-owned' })
  expect(fetch.mock.calls[0][0]).toContain('/api/startup/current-installation?source=original')
  fetch.mockResolvedValue(Response.json({ available: true, preview: { ...preview, publicationState: 'complete', receipt: { serverId: 'other', sourcePreserved: true } } }))
  await expect(readCurrentInstallation('original', new AbortController().signal)).rejects.toMatchObject({ reason: 'invalid-response' })
})
test('the mutation sends only the original preview and label and a lost reply remains unknown', async () => {
  const fetch = vi.fn().mockRejectedValue(new Error('owned network interruption'))
  vi.stubGlobal('fetch', fetch)
  await expect(importCurrentInstallation(preview, 'Current')).rejects.toMatchObject({ data: { code: 'CONFIG_FILE_PUBLISH_UNCONFIRMED', externalOutcome: 'unknown' } })
  expect(JSON.parse(fetch.mock.calls[0][1].body)).toEqual({ token: 'owned-operation', label: 'Current' })
  expect(fetch).toHaveBeenCalledTimes(1)
})
