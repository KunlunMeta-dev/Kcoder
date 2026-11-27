import { WIDGET_BRIDGE_VERSION, WIDGET_LIMITS, type WidgetJson } from './types'

export interface WidgetBridgeEnvelope {
  protocol: 'kcoder-widget'
  version: 1
  token: string
  widgetId: string
  revision: number
  type: 'ready' | 'unconfirmed' | 'resize' | 'error' | 'state' | 'sendPrompt' | 'heartbeat'
  payload: Record<string, unknown>
}

/** Persist a bounded diagnostic code without copying arbitrary renderer text. */
export function widgetRenderErrorCode(message?: string): string {
  const category = /^(invalid_widget|widget_quota|resource_blocked|unsupported_client|render_failed):/.exec(message ?? '')?.[1]
  if (!category) return 'render_failed'
  const detail = /^[a-z_]+:\s+(\/[^\s]*)\s+\(([a-z][a-z0-9_]{0,47})\)/.exec(message ?? '')
  if (!detail) return category
  const numericCountry = /^\/values\/(\d{1,3})$/.exec(detail[1])?.[1]
  const code = [category, detail[2], numericCountry].filter(Boolean).join('_')
  if (code.length <= 64) return code
  const reasonCode = `${category}_${detail[2]}`
  return reasonCode.length <= 64 ? reasonCode : category
}

export function jsonByteLength(value: unknown): number {
  try {
    return new TextEncoder().encode(JSON.stringify(value)).byteLength
  } catch {
    return Infinity
  }
}

export function isWidgetJson(value: unknown, depth = 0): value is WidgetJson {
  if (depth > 16) return false
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return true
  if (typeof value === 'number') return Number.isFinite(value)
  if (Array.isArray(value)) return value.length <= 1024 && value.every(item => isWidgetJson(item, depth + 1))
  if (typeof value !== 'object' || Object.getPrototypeOf(value) !== Object.prototype) return false
  return Object.entries(value).length <= 256 && Object.entries(value).every(([key, item]) =>
    !['__proto__', 'prototype', 'constructor'].includes(key) && isWidgetJson(item, depth + 1))
}

/** Reject large strings/arrays before JSON.stringify can amplify untrusted input. */
export function isBoundedWidgetJson(value: unknown, maxBytes: number): value is WidgetJson {
  let remaining = maxBytes
  let nodes = 0
  const string = (text: string) => {
    if (text.length + 2 > remaining) return false
    remaining -= 2
    for (let index = 0; index < text.length; index += 1) {
      const code = text.charCodeAt(index)
      if (code < 32) remaining -= [8, 9, 10, 12, 13].includes(code) ? 2 : 6
      else if (code === 34 || code === 92) remaining -= 2
      else if (code < 128) remaining -= 1
      else if (code < 2048) remaining -= 2
      else if (code >= 0xd800 && code <= 0xdbff && index + 1 < text.length && text.charCodeAt(index + 1) >= 0xdc00 && text.charCodeAt(index + 1) <= 0xdfff) { remaining -= 4; index += 1 }
      // Well-formed JSON.stringify escapes an unpaired surrogate as six ASCII bytes.
      else if (code >= 0xd800 && code <= 0xdfff) remaining -= 6
      else remaining -= 3
      if (remaining < 0) return false
    }
    return true
  }
  const visit = (item: unknown, depth: number): boolean => {
    if (++nodes > 131072 || depth > 32 || remaining < 0) return false
    if (item === null) { remaining -= 4; return remaining >= 0 }
    if (typeof item === 'string') return string(item)
    if (typeof item === 'boolean') { remaining -= item ? 4 : 5; return remaining >= 0 }
    if (typeof item === 'number') { if (!Number.isFinite(item)) return false; remaining -= String(item).length; return remaining >= 0 }
    if (Array.isArray(item)) {
      if (item.length * 2 + 1 > remaining) return false
      remaining -= 2 + Math.max(0, item.length - 1)
      if (remaining < 0) return false
      for (let index = 0; index < item.length; index += 1) if (!visit(Object.hasOwn(item, index) ? item[index] : null, depth + 1)) return false
      return true
    }
    if (!item || typeof item !== 'object' || Object.getPrototypeOf(item) !== Object.prototype) return false
    remaining -= 2
    let count = 0
    for (const key in item) {
      if (!Object.hasOwn(item, key)) continue
      if (['__proto__', 'prototype', 'constructor'].includes(key)) return false
      remaining -= count++ ? 2 : 1
      if (!string(key) || !visit((item as Record<string, unknown>)[key], depth + 1)) return false
    }
    return remaining >= 0
  }
  return visit(value, 0)
}

export function parseWidgetBridgeMessage(
  value: unknown,
  expected: { token: string; widgetId: string; revision: number }
): WidgetBridgeEnvelope | null {
  if (!value || typeof value !== 'object' || Object.getPrototypeOf(value) !== Object.prototype) return null
  const message = value as Record<string, unknown>
  if (message.protocol !== 'kcoder-widget' || message.version !== WIDGET_BRIDGE_VERSION ||
    message.token !== expected.token || message.widgetId !== expected.widgetId ||
    message.revision !== expected.revision || typeof message.type !== 'string' ||
    !['ready', 'unconfirmed', 'resize', 'error', 'state', 'sendPrompt', 'heartbeat'].includes(message.type) ||
    !message.payload || typeof message.payload !== 'object' || Array.isArray(message.payload)) return null
  if (!isBoundedWidgetJson(value, WIDGET_LIMITS.bridgeBytes)) return null
  const payload = message.payload as Record<string, unknown>
  if (message.type === 'resize' && (typeof payload.height !== 'number' || !Number.isFinite(payload.height))) return null
  if (message.type === 'error' && (typeof payload.message !== 'string' || payload.message.length > 2048)) return null
  if (message.type === 'sendPrompt' && (typeof payload.text !== 'string' || !payload.text.trim() || payload.text.length > 4000)) return null
  if (message.type === 'state' && (!isWidgetJson(payload.state) || jsonByteLength(payload.state) > WIDGET_LIMITS.stateBytes)) return null
  if (message.type === 'heartbeat' && ![payload.domNodes, payload.canvasPixels].every(value => Number.isSafeInteger(value) && (value as number) >= 0)) return null
  return message as unknown as WidgetBridgeEnvelope
}

/** A rejected flood revokes this mount; it does not grant a larger queue. */
export function createWidgetRateLimiter(now: () => number = Date.now) {
  let windowStart = now()
  let count = 0
  return () => {
    const current = now()
    if (current - windowStart >= 1000) { windowStart = current; count = 0 }
    count += 1
    return count <= WIDGET_LIMITS.messagesPerSecond
  }
}
