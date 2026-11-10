import { isBoundedWidgetJson, isWidgetJson } from './bridge'
import { WIDGET_LIMITS, type WidgetJson } from './types'

export const WIDGET_STATE_CACHE_LIMITS = Object.freeze({
  entries: 128,
  encodedBytes: 2 * 1024 * 1024,
  idleMs: 30 * 60 * 1000,
  keyBytes: 4096,
})

interface Options { maxEntries?: number; maxBytes?: number; idleMs?: number; now?: () => number }
interface Entry { serialized: string; bytes: number; accessedAt: number }

/** Optional UI fallback only; eviction never changes an artifact or a mounted state ref. */
export class WidgetStateCache {
  private entries = new Map<string, Entry>()
  private bytes = 0
  private readonly maxEntries: number
  private readonly maxBytes: number
  private readonly idleMs: number
  private readonly now: () => number

  constructor(options: Options = {}) {
    this.maxEntries = options.maxEntries ?? WIDGET_STATE_CACHE_LIMITS.entries
    this.maxBytes = options.maxBytes ?? WIDGET_STATE_CACHE_LIMITS.encodedBytes
    this.idleMs = options.idleMs ?? WIDGET_STATE_CACHE_LIMITS.idleMs
    this.now = options.now ?? Date.now
    if (![this.maxEntries, this.maxBytes, this.idleMs].every(value => Number.isSafeInteger(value) && value > 0)) throw new RangeError('Widget UI cache limits must be positive integers')
  }

  private remove(key: string) {
    const entry = this.entries.get(key)
    if (entry) { this.bytes -= entry.bytes; this.entries.delete(key) }
  }

  private expire() {
    const current = this.now()
    for (const [key, entry] of this.entries) if (current - entry.accessedAt >= this.idleMs) this.remove(key)
  }

  get(key: string): WidgetJson | undefined {
    this.expire()
    const entry = this.entries.get(key)
    if (!entry) return undefined
    this.entries.delete(key); this.entries.set(key, { ...entry, accessedAt: this.now() })
    return JSON.parse(entry.serialized) as WidgetJson
  }

  set(key: string, state: WidgetJson): boolean {
    this.expire()
    if (key.length > WIDGET_STATE_CACHE_LIMITS.keyBytes || !isBoundedWidgetJson(state, WIDGET_LIMITS.stateBytes) || !isWidgetJson(state)) return false
    const encoder = new TextEncoder()
    const keyBytes = encoder.encode(key).byteLength
    if (keyBytes > WIDGET_STATE_CACHE_LIMITS.keyBytes) return false
    const serialized = JSON.stringify(state)
    const bytes = encoder.encode(serialized).byteLength + keyBytes
    if (bytes > this.maxBytes) return false
    this.remove(key)
    this.entries.set(key, { serialized, bytes, accessedAt: this.now() }); this.bytes += bytes
    while (this.entries.size > this.maxEntries || this.bytes > this.maxBytes) this.remove(this.entries.keys().next().value!)
    return true
  }

  get size() { this.expire(); return this.entries.size }
  get encodedBytes() { this.expire(); return this.bytes }
}

export const widgetStateCache = new WidgetStateCache()
