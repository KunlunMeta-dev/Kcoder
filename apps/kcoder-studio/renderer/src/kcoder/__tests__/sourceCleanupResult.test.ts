import { describe, expect, it } from 'vitest'
import { sourceCleanupResult, type StorageMigrationReceipt } from '@/kcoder/storageLocations'

const original = { operationId: 'original-cleanup', confirmation: 'c'.repeat(64) }
const entries = [
  { domain: 'persistent-root', sourceRoot: '/old/root', relativePath: 'original.json',
    status: 'eligibleFile', sizeBytes: 12, observedVersion: 'v'.repeat(64) },
  { domain: 'persistent-root', sourceRoot: '/old/root', relativePath: 'unknown.json',
    status: 'retainedUnknown', sizeBytes: null, observedVersion: null },
]
const result = { ...original, entries: entries.map((entry, index) => ({ ...entry,
  status: index === 0 ? 'removed' : entry.status })) }

function receipt(binding: unknown): StorageMigrationReceipt {
  return {
    plan: {
      version: 1, operationId: original.operationId,
      from: { dataRoot: '/old/root', cacheRoot: '/cache', gatewayRoot: '/old/root/studio/gateway',
        desktopRoot: '/old/root/studio/desktop', temporaryRoot: '/cache/tmp', layout: 'unified',
        sources: { dataRoot: 'selection', cacheRoot: 'selection', gatewayRoot: 'selection', desktopRoot: 'selection' },
        externallyConfigured: false },
      target: { version: 1, revision: 1, dataRoot: '/new/root', cacheRoot: '/cache', operationId: original.operationId },
      components: [], launchIntent: 'desktop',
    },
    phase: 'verified', disposition: 'complete', ownerReceipts: { 'source-cleanup': binding },
  }
}

function compact() {
  return { version: 2, preview: { ...original, pending: false,
    sources: [{ domain: 'persistent-root', sourceRoot: '/old/root',
      entries: entries.map(entry => ({ relativePath: entry.relativePath, status: entry.status,
        sizeBytes: entry.sizeBytes, observedVersion: entry.observedVersion })) }] },
  resultStatuses: ['removed', 'retainedUnknown'] }
}

describe('original source cleanup reply reconciliation', () => {
  it('reads the original v1 final reply without changing the receipt', () => {
    const saved = receipt({ version: 1, preview: { ...original, entries }, result })
    const before = JSON.stringify(saved)
    expect(sourceCleanupResult(saved, original)).toEqual(result)
    expect(JSON.stringify(saved)).toBe(before)
    expect(sourceCleanupResult(receipt({ version: 1, result: null }), original)).toBeNull()
  })

  it('expands v2 same-order final statuses and preserves unknown entries', () => {
    const saved = receipt(compact())
    const before = JSON.stringify(saved)
    expect(sourceCleanupResult(saved, original)).toEqual(result)
    expect(JSON.stringify(saved)).toBe(before)
  })

  it('keeps pending, foreign, incomplete and malformed replies unresolved', () => {
    expect(sourceCleanupResult(receipt({ ...compact(), resultStatuses: null }), original)).toBeNull()
    expect(sourceCleanupResult(receipt({ ...compact(), resultStatuses: ['removed'] }), original)).toBeNull()
    expect(sourceCleanupResult(receipt({ ...compact(), resultStatuses: ['removed', 'unrecognized'] }), original)).toBeNull()
    expect(sourceCleanupResult(receipt({ ...compact(), version: 3 }), original)).toBeNull()
    const saved = receipt(compact())
    expect(sourceCleanupResult(saved, { ...original, operationId: 'another-operation' })).toBeNull()
    expect(sourceCleanupResult(saved, { ...original, confirmation: 'd'.repeat(64) })).toBeNull()
    expect(sourceCleanupResult({ ...saved, disposition: 'active' }, original)).toBeNull()
    expect(sourceCleanupResult({ ...saved, phase: 'prepared' }, original)).toBeNull()
  })
})
