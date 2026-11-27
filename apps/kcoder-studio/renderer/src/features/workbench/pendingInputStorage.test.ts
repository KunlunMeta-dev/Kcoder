import { afterEach, expect, test, vi } from 'vitest'
import {
  readComposerDraft,
  readPendingInputs,
  removePendingInputs,
  writeComposerDraft,
  writePendingInputs,
} from './pendingInputStorage'
import {
  notifyAccountContextChange,
  updateVerifiedAccountContextScope,
} from '@/kcoder/accountContextEvents'
import type { RuntimePaneQueuedMessage } from '@/types/workbench'

const key = 'recovery-target:task'
const row: RuntimePaneQueuedMessage = {
  id: 'original-input',
  content: 'keep this input',
  status: 'sending',
  createdAt: 'now',
}
afterEach(() => removePendingInputs(''))

test('reload retains the request identity and changes in-flight work to unknown', () => {
  updateVerifiedAccountContextScope('recovery-target', 'account-a')
  writePendingInputs(key, [row])
  expect(readPendingInputs(key)).toMatchObject([
    { id: row.id, content: row.content, status: 'unknown', ownerKey: key },
  ])
})

test('closing the tab retains queued and unknown inputs in the persistent profile', () => {
  updateVerifiedAccountContextScope('recovery-target', 'account-a')
  writePendingInputs(key, [{ ...row, status: 'queued' }, { ...row, id: 'unconfirmed', status: 'unknown' }])
  sessionStorage.clear()
  expect(readPendingInputs(key)).toMatchObject([
    { id: row.id, content: row.content, status: 'queued' },
    { id: 'unconfirmed', content: row.content, status: 'unknown' },
  ])
})

test('an existing tab migrates its original request identities without overriding persisted work', () => {
  updateVerifiedAccountContextScope('recovery-target', 'account-a')
  const storageKey = 'kcoder.pending-inputs.v1::' + key
  sessionStorage.setItem(storageKey, JSON.stringify({ scope: 'account-a', rows: [{ ...row, ownerKey: key }] }))
  expect(readPendingInputs(key)).toMatchObject([{ id: row.id, status: 'unknown' }])
  expect(sessionStorage.getItem(storageKey)).toBeNull()
  writePendingInputs(key, [{ ...row, content: 'current text', status: 'queued' }])
  sessionStorage.setItem(storageKey, JSON.stringify({ scope: 'account-a', rows: [{ ...row, ownerKey: key }] }))
  expect(readPendingInputs(key)).toMatchObject([{ id: row.id, content: 'current text', status: 'queued' }])
  writePendingInputs(key, [])
  expect(readPendingInputs(key)).toEqual([])
})

test('a partial legacy migration keeps all original inputs and its source until persistence succeeds', () => {
  updateVerifiedAccountContextScope('recovery-target', 'account-a')
  const storageKey = 'kcoder.pending-inputs.v1::' + key
  const legacyRows = [row, { ...row, id: 'second-input' }].map(value => ({ ...value, ownerKey: key }))
  const original = JSON.stringify({ scope: 'account-a', rows: legacyRows })
  sessionStorage.setItem(storageKey, original)
  const setItem = Storage.prototype.setItem
  const failure = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(function (this: Storage, storageKey, value) {
    if (storageKey.endsWith(':second-input')) throw new Error('fixture quota exceeded')
    setItem.call(this, storageKey, value)
  })
  try {
    expect(readPendingInputs(key).map(input => input.id)).toEqual([row.id, 'second-input'])
    expect(sessionStorage.getItem(storageKey)).toBe(original)
  } finally {
    failure.mockRestore()
  }
  expect(readPendingInputs(key).map(input => input.id)).toEqual([row.id, 'second-input'])
  expect(sessionStorage.getItem(storageKey)).toBeNull()
})

test('interleaved distinct-input writes and deletions cannot overwrite another window', () => {
  updateVerifiedAccountContextScope('recovery-target', 'account-a')
  const first = { ...row, status: 'queued' as const }
  const peer = { ...row, id: 'peer-during-write', status: 'unknown' as const }
  const later = { ...row, id: 'peer-during-delete', status: 'queued' as const }
  const storageKey = 'kcoder.pending-inputs.v2::' + key + ':' + row.id
  const setItem = Storage.prototype.setItem
  let peerWritten = false
  const write = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(function (this: Storage, entryKey, value) {
    if (entryKey === storageKey && !peerWritten) {
      peerWritten = true
      writePendingInputs(key, [peer], [])
    }
    setItem.call(this, entryKey, value)
  })
  try {
    writePendingInputs(key, [first], [])
  } finally {
    write.mockRestore()
  }
  const removeItem = Storage.prototype.removeItem
  const remove = vi.spyOn(Storage.prototype, 'removeItem').mockImplementation(function (this: Storage, entryKey) {
    if (entryKey === storageKey) writePendingInputs(key, [later], [])
    removeItem.call(this, entryKey)
  })
  try {
    writePendingInputs(key, [], [first])
  } finally {
    remove.mockRestore()
  }
  expect(readPendingInputs(key).map(input => input.id).sort()).toEqual([later.id, peer.id].sort())
})

test('an unverified or changed account cannot read the previous account draft', () => {
  updateVerifiedAccountContextScope('recovery-target', 'account-a')
  writePendingInputs(key, [row])
  updateVerifiedAccountContextScope('recovery-target', null)
  expect(readPendingInputs(key)).toEqual([])
  updateVerifiedAccountContextScope('recovery-target', 'account-b')
  expect(readPendingInputs(key)).toEqual([])
})

test('target invalidation removes unopened queued drafts without touching other storage', () => {
  sessionStorage.setItem('other-feature', 'keep')
  updateVerifiedAccountContextScope('recovery-target', 'account-a')
  writePendingInputs(key, [row])
  removePendingInputs('recovery-target:')
  expect(readPendingInputs(key)).toEqual([])
  expect(sessionStorage.getItem('other-feature')).toBe('keep')
  sessionStorage.removeItem('other-feature')
})

test('a fresh pane cache restores the queue paused instead of replaying it', async () => {
  vi.resetModules()
  const storage = await import('./pendingInputStorage')
  const account = await import('@/kcoder/accountContextEvents')
  account.updateVerifiedAccountContextScope('fresh-target', 'account')
  storage.writePendingInputs('fresh-target:task', [{ ...row, status: 'queued' }])
  const cache = await import('./runtimeConversationCache')
  expect(cache.getRuntimeConversationQueuedMessagesByKey('fresh-target:task')).toMatchObject([
    { id: row.id, status: 'queued' },
  ])
  expect(cache.getRuntimeConversationQueuePausedByKey('fresh-target:task')).toBe(true)
  cache.evictRuntimeTargetConversations('fresh-target')
  expect(cache.getRuntimeConversationQueuedMessagesByKey('fresh-target:task')).toEqual([])
})

test('account invalidation immediately blocks draft restoration until fresh metadata arrives', () => {
  updateVerifiedAccountContextScope('recovery-target', 'account-a')
  writePendingInputs(key, [row])
  notifyAccountContextChange('recovery-target')
  expect(readPendingInputs(key)).toEqual([])
})

test('same-account reauthentication restores the original input while a different account stays isolated', async () => {
  const cache = await import('./runtimeConversationCache')
  updateVerifiedAccountContextScope('recovery-target', 'account-a')
  writePendingInputs(key, [row])
  notifyAccountContextChange('recovery-target')
  cache.evictRuntimeTargetConversations('recovery-target', true)
  expect(readPendingInputs(key)).toEqual([])
  // A late empty update from the retired pane cannot discard an unverified locator.
  writePendingInputs(key, [])
  updateVerifiedAccountContextScope('recovery-target', 'account-b')
  expect(readPendingInputs(key)).toEqual([])
  updateVerifiedAccountContextScope('recovery-target', 'account-a')
  expect(readPendingInputs(key)).toMatchObject([{ id: row.id, status: 'unknown' }])
})

test('composer text survives window closure and remains private to its account and task or workspace', () => {
  updateVerifiedAccountContextScope('recovery-target', 'account-a')
  const workspaceKey = 'recovery-target:blank:[7,"/workspace"]'
  writeComposerDraft(key, 'task draft')
  writeComposerDraft(workspaceKey, 'new task draft')
  sessionStorage.clear()
  expect(readComposerDraft(key)).toBe('task draft')
  expect(readComposerDraft(workspaceKey)).toBe('new task draft')
  expect(readComposerDraft('recovery-target:other-task')).toBeNull()
  expect(readComposerDraft('recovery-target:blank:[7,"/other-workspace"]')).toBeNull()
  notifyAccountContextChange('recovery-target')
  expect(readComposerDraft(key)).toBeNull()
  updateVerifiedAccountContextScope('recovery-target', 'account-b')
  expect(readComposerDraft(key)).toBeNull()
  updateVerifiedAccountContextScope('recovery-target', 'account-a')
  expect(readComposerDraft(key)).toBe('task draft')
  writeComposerDraft(key, '')
  writeComposerDraft(workspaceKey, '')
  expect(readComposerDraft(key)).toBeNull()
})

test('separate application mounts cannot restore each other\'s input or composer draft', () => {
  updateVerifiedAccountContextScope('recovery-target', 'account-a')
  try {
    window.__KCODER_STUDIO_RUNTIME_CONFIG__ = { appBasePath: '/first' }
    writePendingInputs(key, [row])
    writeComposerDraft(key, 'private mounted draft')
    window.__KCODER_STUDIO_RUNTIME_CONFIG__ = { appBasePath: '/second' }
    expect(readPendingInputs(key)).toEqual([])
    expect(readComposerDraft(key)).toBeNull()
    window.__KCODER_STUDIO_RUNTIME_CONFIG__ = { appBasePath: '/first' }
    expect(readPendingInputs(key)).toMatchObject([{ id: row.id }])
    expect(readComposerDraft(key)).toBe('private mounted draft')
  } finally {
    removePendingInputs('')
    writeComposerDraft(key, '')
    delete window.__KCODER_STUDIO_RUNTIME_CONFIG__
  }
})
