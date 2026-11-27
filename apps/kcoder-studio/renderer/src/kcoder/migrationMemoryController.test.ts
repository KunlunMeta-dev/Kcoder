import { beforeEach, expect, it, vi } from 'vitest'
import { createMemoryManager } from './migrationMemoryController'
import type { createMemoryApi } from './gatewayMigrationMemory'
import type { ImportedMemoryRecordSummary } from '../../../shared/generated/contracts'

const record: ImportedMemoryRecordSummary = { id: 'ctx-owned', ownerOperationId: 'owner', name: 'Notes', scope: { kind: 'global' }, enabled: false, revision: 'original', bytes: 20 }
const api = () => ({ memoryList: vi.fn().mockResolvedValue({ items: [record], totalRecords: 1, nextPage: null }), memoryRead: vi.fn(), memoryControl: vi.fn(), memoryControlRead: vi.fn(), memoryDiscover: vi.fn(), memorySources: vi.fn() })
const make = (port: ReturnType<typeof api>, isCurrent = () => true, scope = 'owned') => createMemoryManager({ api: port as ReturnType<typeof createMemoryApi>, storage: localStorage, isCurrent, scope })
beforeEach(() => localStorage.clear())

it('requires explicit enable confirmation, persists a stable selector before submission, and never replays a lost response', async () => {
  const port = api(), manager = make(port)
  await manager.control(record, true, false); expect(port.memoryControl).not.toHaveBeenCalled()
  port.memoryControl.mockImplementation(async input => {
    expect(JSON.parse(localStorage.getItem('kcoder.migration.memory-control:owned')!)).toEqual(input)
    throw new Error('connection lost after Native accepted')
  })
  await manager.control(record, true, true)
  const pending = manager.getSnapshot().pending!
  expect(pending.requestId).toBeTruthy(); expect(port.memoryControl).toHaveBeenCalledOnce()
  expect(manager.getSnapshot().error).toBe('outcomeUnknown')
  const reopened = make(port)
  expect(reopened.getSnapshot().pending).toEqual(pending)
  expect(port.memoryControlRead).not.toHaveBeenCalled()
  port.memoryControlRead.mockResolvedValue({ receipt: { request: pending, appliedRevision: 'applied' }, current: { ...record, revision: 'later', enabled: false } })
  await reopened.check()
  expect(port.memoryControlRead).toHaveBeenCalledWith({ requestId: pending.requestId })
  expect(port.memoryControl).toHaveBeenCalledOnce()
  expect(reopened.getSnapshot().outcome?.receipt?.request.enabled).toBe(true)
  expect(reopened.getSnapshot().outcome?.current?.enabled).toBe(false)
  reopened.acknowledge(); expect(reopened.getSnapshot().pending).toBeNull()
})
it('an absent receipt permits only an explicit retry of the exact original CAS; another scope sees no selector', async () => {
  const port = api(), manager = make(port)
  port.memoryControl.mockRejectedValue(new Error('lost'))
  await manager.control(record, false, false)
  const pending = manager.getSnapshot().pending!
  await manager.retry(); expect(port.memoryControl).toHaveBeenCalledOnce()
  port.memoryControlRead.mockResolvedValue({ receipt: null, current: null })
  await manager.check(); manager.acknowledge()
  expect(manager.getSnapshot().pending).toEqual(pending)
  await manager.retry()
  expect(port.memoryControl).toHaveBeenLastCalledWith(pending)
  expect(port.memoryControl).toHaveBeenCalledTimes(2)
  expect(make(port, () => true, 'other-account').getSnapshot().pending).toBeNull()
})
it('rejects late data after disposal and account changes, including strict-mode lifetime reactivation', async () => {
  const port = api(), manager = make(port)
  let resolve!: (value: unknown) => void
  port.memoryList.mockImplementationOnce(() => new Promise(done => { resolve = done }))
  const pending = manager.load()
  manager.dispose(); manager.activate()
  resolve({ items: [record], totalRecords: 1, nextPage: null }); await pending
  expect(manager.getSnapshot().page).toBeNull()
  let valid = true
  const account = make(port, () => valid)
  port.memoryRead.mockImplementationOnce(() => new Promise(done => { resolve = done }))
  const text = account.read(record)
  valid = false; resolve({ record, text: 'OLD ACCOUNT', totalBytes: 11, nextOffset: null }); await text
  expect(account.getSnapshot().body).toBeNull()
})
it('does not allow source text or another record revision to overwrite the selected body', async () => {
  const port = api(), manager = make(port)
  port.memoryRead.mockResolvedValue({ record: { ...record, revision: 'changed' }, text: 'changed', totalBytes: 7, nextOffset: null })
  await manager.read(record)
  expect(manager.getSnapshot().body).toBeNull()
  expect(manager.getSnapshot().error).toBe('readFailed')
})
it('rejects corrupt recovery storage and never sends an unsaved selector', async () => {
  const port = api()
  localStorage.setItem('kcoder.migration.memory-control:owned', '{bad')
  const manager = make(port)
  await manager.control(record, false, false)
  expect(port.memoryControl).not.toHaveBeenCalled()
  expect(localStorage.getItem('kcoder.migration.memory-control:owned')).toBe('{bad')
})
