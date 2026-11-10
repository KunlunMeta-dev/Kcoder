import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { createMigrationTargetRecovery } from './migrationTargetRecovery'
import { migrationSourceRecoveryScope } from './migrationSourceTransferScope'
import type { GatewayServer } from './gatewayRpc'

const target: GatewayServer = { id: 'target', label: 'Target', description: '', runtime: 'kcoder', transport: 'local' }
const id = '22222222-2222-4222-8222-222222222222'
const response = (value: unknown) => new Response(JSON.stringify(value))
const unknown = { requestId: id, coordinatorState: 'unknown', observation: 'unobserved', result: null, progress: null, errorCode: null }
function seed() {
  const request = { requestId: id, source: { sessionId: id, purpose: 'source', targetId: 'unavailable-source' }, target: { sessionId: id, purpose: 'target', targetId: target.id } }
  localStorage.setItem(`kcoder.migration.transfer:${migrationSourceRecoveryScope(target)}:${id}`, JSON.stringify({ version: 1, request, attemptId: id }))
}
beforeEach(() => { localStorage.clear(); seed() })
afterEach(() => { delete window.__KCODER_STUDIO_RUNTIME_CONFIG__ })
it('opens only target recovery and reads the original operation without source access or mutation replay', async () => {
  const fetcher = vi.fn<typeof fetch>().mockImplementation(async url => String(url).endsWith('/open')
    ? response({ status: 'ready', launching: false, ownedChildren: 1 })
    : String(url).endsWith('/close') ? response({ status: 'released' }) : response(unknown))
  const recovery = createMigrationTargetRecovery({ target, storage: localStorage, captureScope: () => 'a', captureCleanupScope: () => 'a', fetcher })
  expect(recovery.list().total).toBe(1)
  expect(fetcher).not.toHaveBeenCalled()
  await expect(recovery.read(id)).resolves.toEqual(unknown)
  await recovery.read(id)
  expect(JSON.parse(String(fetcher.mock.calls[0][1]?.body))).toMatchObject({ purpose: 'target_recovery', targetId: 'target' })
  expect(fetcher.mock.calls.map(call => String(call[0]))).toEqual(['/api/migration/source-session/open', '/api/migration/source-transfer/target-read', '/api/migration/source-transfer/target-read'])
  expect(JSON.parse(String(fetcher.mock.calls[1][1]?.body))).not.toHaveProperty('source')
  await recovery.release()
  await expect(recovery.read(id)).rejects.toMatchObject({ code: 'source_transfer_authority_changed' })
})
it('does not close an old connection under a changed account', async () => {
  let account = 'a'
  const fetcher = vi.fn<typeof fetch>().mockImplementation(async url => String(url).endsWith('/open')
    ? response({ status: 'ready', launching: false, ownedChildren: 1 }) : response(unknown))
  const recovery = createMigrationTargetRecovery({ target, storage: localStorage, captureScope: () => account, captureCleanupScope: () => account, fetcher })
  await recovery.read(id)
  account = 'b'
  await expect(recovery.release()).rejects.toMatchObject({ code: 'source_transfer_request_not_sent' })
  expect(fetcher).toHaveBeenCalledTimes(2)
})
it('keeps relay-mounted recovery records separate even with matching target identifiers', () => {
  window.__KCODER_STUDIO_RUNTIME_CONFIG__ = { appBasePath: '/g/other' }
  const recovery = createMigrationTargetRecovery({ target, storage: localStorage, captureScope: () => 'a', captureCleanupScope: () => 'a' })
  expect(recovery.list().total).toBe(0)
})
it('a late connection response after release cannot query the target', async () => {
  let finish!: (value: Response) => void
  const fetcher = vi.fn<typeof fetch>().mockImplementation(async url => String(url).endsWith('/open')
    ? new Promise(resolve => { finish = resolve }) : response({ status: 'released' }))
  const recovery = createMigrationTargetRecovery({ target, storage: localStorage, captureScope: () => 'a', captureCleanupScope: () => 'a', fetcher })
  const pending = recovery.read(id)
  await recovery.release()
  finish(response({ status: 'ready', launching: false, ownedChildren: 1 }))
  await expect(pending).rejects.toMatchObject({ code: 'source_transfer_authority_changed' })
  expect(fetcher.mock.calls.some(call => String(call[0]).includes('target-read'))).toBe(false)
})
