import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import examples from '../../../shared/generated/examples.migration-source-credentials.json'
import type { MigrationSourceCredentialRunParams } from '../../../shared/generated/contracts'
import { createPrivateCredentialRecovery } from '../../../shared/migrationPrivateCredentialRecovery'
import { createMigrationPrivateCredentialClient } from './gatewayMigrationPrivateCredentials'

const original = examples.MigrationSourceCredentialRunParams[0].value as MigrationSourceCredentialRunParams
const offered = examples.MigrationSourceCredentialResult[0].value
const response = () => new Response(JSON.stringify(offered))
beforeEach(() => localStorage.clear())
afterEach(() => vi.restoreAllMocks())
function fixture() {
  let scope = 'original'
  const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => response())
  const client = createMigrationPrivateCredentialClient({ captureScope: () => scope, fetcher })
  const cache = createPrivateCredentialRecovery({ storage: localStorage, client, captureScope: () => scope, recoveryScope: 'original-target-account' })
  return { fetcher, cache, changeScope: () => { scope = 'replacement' } }
}

it('persists the original offer before dispatch and reads it after a lost reply instead of rerunning', async () => {
  const { cache, fetcher } = fixture()
  fetcher.mockImplementationOnce(async () => {
    expect(cache.list().items).toEqual([original])
    throw new Error('lost mutation reply')
  })
  await expect(cache.run(original)).rejects.toMatchObject({ outcomeUnknown: true })
  const fresh = { ...original, locator: { ...original.locator, offerId: '44444444-4444-4444-8444-444444444444',
    target: { ...original.locator.target, sessionId: '55555555-5555-4555-8555-555555555555' } } }
  await expect(cache.run(fresh)).resolves.toMatchObject({ input: original, result: offered })
  expect(fetcher.mock.calls.map(call => call[0])).toEqual(['/api/migration/source-transfer/private/run', '/api/migration/source-transfer/private/read'])
  expect(JSON.parse(String(fetcher.mock.calls[1][1]?.body))).toEqual({ ...original.locator, target: fresh.locator.target })
})

it('does not dispatch when durable storage is unavailable', async () => {
  const { cache, fetcher } = fixture()
  vi.spyOn(Storage.prototype, 'setItem').mockImplementationOnce(() => { throw new Error('quota') })
  await expect(cache.run(original)).rejects.toMatchObject({ code: 'private_credentials_recovery_unavailable', outcomeUnknown: false })
  expect(fetcher).not.toHaveBeenCalled()
})

it('refuses changed selection under an existing offer and never moves recovery to a peer target', async () => {
  const { cache, fetcher } = fixture()
  await cache.run(original)
  await expect(cache.run({ ...original, entryId: 'e0000-0001' })).rejects.toMatchObject({ code: 'private_credentials_binding_changed' })
  await expect(cache.read(original, { ...original.locator.target, targetId: 'peer-target' })).rejects.toMatchObject({ code: 'private_credentials_binding_changed' })
  expect(fetcher).toHaveBeenCalledOnce()
})

it('rejects raw private fields before caching and ignores another account namespace', async () => {
  const { cache, fetcher } = fixture()
  await expect(cache.run({ ...original, plaintext: 'SYNTHETIC_PRIVATE_VALUE' } as never)).rejects.toMatchObject({ code: 'private_credentials_invalid_request' })
  expect(localStorage.length).toBe(0)
  expect(fetcher).not.toHaveBeenCalled()
  await cache.run(original)
  const other = createPrivateCredentialRecovery({ storage: localStorage,
    client: createMigrationPrivateCredentialClient({ captureScope: () => 'peer', fetcher }), captureScope: () => 'peer', recoveryScope: 'peer-account' })
  expect(other.list().items).toEqual([])
})

it('rejects a late run response after ownership changes and retains only its original intent', async () => {
  const { cache, fetcher, changeScope } = fixture()
  let finish!: (value: Response) => void
  fetcher.mockImplementationOnce(() => new Promise(resolve => { finish = resolve }))
  const pending = cache.run(original)
  await vi.waitFor(() => expect(fetcher).toHaveBeenCalledOnce())
  changeScope(); finish(response())
  await expect(pending).rejects.toMatchObject({ code: 'source_transfer_authority_changed', outcomeUnknown: true })
  expect(localStorage.length).toBe(1)
  expect(() => cache.list()).toThrow('private_credentials_authority_changed')
})

it('reopens persisted metadata in pages of ten without contacting the source or running a mutation', async () => {
  const { cache, fetcher } = fixture()
  for (let index = 0; index < 11; index++) {
    const offerId = `33333333-3333-4333-8333-${String(index).padStart(12, '0')}`
    const input = { ...original, entryId: `e0000-${String(index).padStart(4, '0')}`, locator: { ...original.locator, offerId } }
    fetcher.mockResolvedValueOnce(new Response(JSON.stringify({ ...offered, offerId })))
    await cache.run(input)
  }
  expect(cache.list()).toMatchObject({ totalItems: 11, nextPage: 1 })
  expect(cache.list().items).toHaveLength(10)
  expect(cache.list(1).items).toHaveLength(1)
  expect(cache.list(1).nextPage).toBeNull()
  expect(fetcher).toHaveBeenCalledTimes(11)
})

it('reconciles the same selected field set despite object and selection ordering changes', async () => {
  const { cache, fetcher } = fixture()
  const input = structuredClone(original)
  input.consent.mcpPrivateFields = true
  input.selections.push({ kind: 'mcp', definitionSha256: 'a'.repeat(64), sourceName: 'notes', targetName: 'notes',
    fields: [{ kind: 'environment', name: 'TOKEN' }, { kind: 'header', name: 'X-Owned' }] })
  await cache.run(input)
  const next = structuredClone(input)
  next.locator.offerId = '66666666-6666-4666-8666-666666666666'
  next.selections.reverse()
  for (const item of next.selections) if (item.kind === 'mcp') item.fields.reverse()
  next.consent = { mcpPrivateFields: next.consent.mcpPrivateFields, apiKeys: next.consent.apiKeys }
  expect(cache.locate(next).locator.offerId).toBe(original.locator.offerId)
  await cache.run(next)
  expect(fetcher.mock.calls.map(call => String(call[0]).split('/').at(-1))).toEqual(['run', 'read'])
  expect(cache.list().totalItems).toBe(1)
})
