import { getRuntimeConfig } from '@/config/runtime'
import { verifiedAccountContextScopes } from '@/kcoder/accountContextEvents'
import type { RuntimePaneQueuedMessage } from '@/types/workbench'

const prefix = () => `kcoder.pending-inputs.v2:${getRuntimeConfig().appBasePath}:`
const legacyPrefix = () => `kcoder.pending-inputs.v1:${getRuntimeConfig().appBasePath}:`
const draftPrefix = () => `kcoder.composer-drafts.v1:${getRuntimeConfig().appBasePath}:`
const statuses = new Set([
  'queued',
  'failed',
  'sending',
  'accepted',
  'running',
  'unknown',
  'interrupted',
])
export function pendingInputAccountScope(key: string): string | null {
  const accountScopes = verifiedAccountContextScopes()
  const target = [...accountScopes.keys()]
    .sort((a, b) => b.length - a.length)
    .find(id => key.startsWith(`${id}:`))
  return target ? (accountScopes.get(target) ?? null) : null
}

function isPendingInput(row: unknown, key: string): row is RuntimePaneQueuedMessage {
  if (!row || typeof row !== 'object') return false
  const value = row as RuntimePaneQueuedMessage
  return Boolean(
    value.ownerKey === key &&
    typeof value.id === 'string' && value.id.length > 0 && value.id.length <= 1024 &&
    typeof value.content === 'string' && typeof value.createdAt === 'string' &&
    statuses.has(value.status) &&
    (value.turnId === undefined || (typeof value.turnId === 'string' && value.turnId.length > 0)) &&
    (value.cancelRequested === undefined || typeof value.cancelRequested === 'boolean') &&
    (value.deliveryMode === undefined || value.deliveryMode === 'guidance') &&
    (value.attachments === undefined ||
      (Array.isArray(value.attachments) && value.attachments.every(
        (file: unknown) => file && typeof file === 'object' &&
          'filename' in file && typeof file.filename === 'string' &&
          'id' in file && typeof file.id === 'number'
      )))
  )
}

const inputKey = (key: string, id: string) => `${prefix()}${key}:${encodeURIComponent(id)}`

function savedInput(key: string, row: RuntimePaneQueuedMessage): RuntimePaneQueuedMessage {
  return {
    ...row,
    ownerKey: key,
    attachments: row.attachments?.map(attachment => {
      const saved = { ...attachment }
      delete saved.local_preview_url
      delete saved.text_content
      return saved
    }),
  }
}

/** Profile-local drafts and request identities, never an execution or authorization receipt. */
export function readPendingInputs(key: string): RuntimePaneQueuedMessage[] {
  const rows = new Map<string, RuntimePaneQueuedMessage>()
  const persistedIds = new Set<string>()
  try {
    const scope = pendingInputAccountScope(key)
    if (!scope) return []
    for (const storageKey of Object.keys(window.localStorage)) {
      if (!storageKey.startsWith(`${prefix()}${key}:`)) continue
      try {
        const value = JSON.parse(window.localStorage.getItem(storageKey) ?? 'null')
        if (value?.scope === scope && isPendingInput(value.row, key) &&
          storageKey === inputKey(key, value.row.id)) {
          rows.set(value.row.id, value.row)
          persistedIds.add(value.row.id)
        }
      } catch {
        /* A damaged entry cannot hide other original request identities. */
      }
    }
    for (const storage of [window.localStorage, window.sessionStorage]) {
      const storageKey = legacyPrefix() + key
      try {
        const value = JSON.parse(storage.getItem(storageKey) ?? 'null')
        if (value?.scope !== scope || !Array.isArray(value.rows)) continue
        const legacyRows = value.rows.filter((row: unknown): row is RuntimePaneQueuedMessage => isPendingInput(row, key))
        for (const row of legacyRows) if (!rows.has(row.id)) rows.set(row.id, row)
        let migrated = legacyRows.length === value.rows.length
        for (const row of legacyRows) {
          if (persistedIds.has(row.id)) continue
          const entryKey = inputKey(key, row.id)
          // An existing entry wins; conflicting or damaged bytes are retained for recovery.
          if (window.localStorage.getItem(entryKey) !== null) { migrated = false; continue }
          try {
            window.localStorage.setItem(entryKey, JSON.stringify({ scope, row: savedInput(key, row) }))
            persistedIds.add(row.id)
          } catch {
            migrated = false
          }
        }
        if (migrated) storage.removeItem(storageKey)
      } catch {
        /* Keep the legacy copy until every original input is durably retained. */
      }
    }
  } catch {
    /* Already read identities remain recoverable when storage becomes unavailable. */
  }
  return [...rows.values()]
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
    .map(row => ({
      ...row,
      // An interrupted page cannot prove what happened to an in-flight input.
      status: row.status === 'queued' || row.status === 'failed' ? row.status : 'unknown',
      notice: undefined,
    }))
}

export function writePendingInputs(
  key: string,
  rows: RuntimePaneQueuedMessage[],
  previousRows?: RuntimePaneQueuedMessage[]
): void {
  try {
    const scope = pendingInputAccountScope(key)
    if (!scope) return
    const previous = previousRows ?? readPendingInputs(key)
    for (const row of rows)
      window.localStorage.setItem(inputKey(key, row.id), JSON.stringify({ scope, row: savedInput(key, row) }))
    const retainedIds = new Set(rows.map(row => row.id))
    // Distinct inputs have distinct keys, so other windows cannot lose an unobserved input.
    for (const row of previous)
      if (!retainedIds.has(row.id)) window.localStorage.removeItem(inputKey(key, row.id))
  } catch {
    console.warn('[KCoder] Pending input recovery storage is unavailable')
  }
}

export function removePendingInputs(keyPrefix: string): void {
  try {
    for (const storage of [window.localStorage, window.sessionStorage])
      for (const key of Object.keys(storage))
        if (key.startsWith(prefix() + keyPrefix) || key.startsWith(legacyPrefix() + keyPrefix))
          storage.removeItem(key)
  } catch {
    /* In-memory cleanup remains available without browser storage. */
  }
}

export function readComposerDraft(key: string): string | null {
  try {
    const scope = pendingInputAccountScope(key)
    if (!scope) return null
    const value = JSON.parse(window.localStorage.getItem(draftPrefix() + key) ?? 'null')
    return value?.scope === scope && typeof value.content === 'string' ? value.content : null
  } catch {
    return null
  }
}

export function writeComposerDraft(key: string, content: string): void {
  try {
    const scope = pendingInputAccountScope(key)
    if (!scope) return
    const storageKey = draftPrefix() + key
    if (content.length === 0) window.localStorage.removeItem(storageKey)
    else window.localStorage.setItem(storageKey, JSON.stringify({ scope, content }))
  } catch {
    console.warn('[KCoder] Composer draft recovery storage is unavailable')
  }
}
