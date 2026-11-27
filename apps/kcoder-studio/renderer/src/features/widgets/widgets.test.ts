import { describe, expect, it } from 'vitest'
import { compoundInterest } from './compoundInterest'
import { createWidgetRateLimiter, isBoundedWidgetJson, isWidgetJson, parseWidgetBridgeMessage, widgetRenderErrorCode } from './bridge'
import { WidgetFramePool } from './framePool'

describe('independent compound interest baseline', () => {
  it('matches the seven-year calculation before formatting', () => {
    const result = compoundInterest(560000, 0.085, 7)
    expect(result.total).toBeCloseTo(991279.658373168, 5)
    expect(result.earnings).toBeCloseTo(431279.658373168, 5)
    expect(result.earningsShare).toBeCloseTo(0.43507364922726216, 10)
    expect(result.series).toHaveLength(8)
  })
  it('handles no principal, zero years and a complete loss', () => {
    expect(compoundInterest(0, 0.1, 10).earningsShare).toBe(0)
    expect(compoundInterest(100, 0.1, 0).total).toBe(100)
    expect(compoundInterest(100, -1, 1).total).toBe(0)
    expect(compoundInterest(100, -0.1, 2).total).toBeCloseTo(81)
  })
  it.each([[NaN, 0, 1], [100, Infinity, 1], [-1, 0, 1], [100, -2, 1], [100, 0, 0.5], [100, 0, 101]])('rejects invalid inputs %j', (principal, rate, years) => {
    expect(() => compoundInterest(principal, rate, years)).toThrow()
  })
})

describe('widget bridge', () => {
  const expected = { token: 'opaque-owner-token', widgetId: 'widget-a', revision: 4 }
  const envelope = (type: string, payload: unknown) => ({ protocol: 'kcoder-widget', version: 1, ...expected, type, payload })
  it('accepts only the current mount and revision', () => {
    expect(parseWidgetBridgeMessage(envelope('ready', {}), expected)).not.toBeNull()
    for (const change of [{ token: 'old' }, { widgetId: 'other' }, { revision: 3 }, { version: 2 }, { protocol: 'parent-rpc' }]) {
      expect(parseWidgetBridgeMessage({ ...envelope('ready', {}), ...change }, expected)).toBeNull()
    }
  })
  it('has no generic RPC, links, downloads or auto-send channel', () => {
    for (const type of ['rpc', 'tools/call', 'openUrl', 'download', 'send']) expect(parseWidgetBridgeMessage(envelope(type, {}), expected)).toBeNull()
    expect(parseWidgetBridgeMessage(envelope('sendPrompt', { text: 'Explain this region' }), expected)).not.toBeNull()
    expect(parseWidgetBridgeMessage(envelope('sendPrompt', { text: '' }), expected)).toBeNull()
  })
  it('rejects unsafe, oversized and nonfinite state/resize data', () => {
    expect(isWidgetJson({ value: Infinity })).toBe(false)
    expect(isWidgetJson(JSON.parse('{"__proto__":{"owned":true}}'))).toBe(false)
    expect(parseWidgetBridgeMessage(envelope('state', { state: { text: 'x'.repeat(16384) } }), expected)).toBeNull()
    expect(parseWidgetBridgeMessage(envelope('resize', { height: NaN }), expected)).toBeNull()
    expect(parseWidgetBridgeMessage(envelope('resize', { height: 300 }), expected)).not.toBeNull()
    expect(parseWidgetBridgeMessage(envelope('state', { state: { principal: 560000, years: 7 } }), expected)).not.toBeNull()
  })
  it('revokes a flood without an unbounded pending queue', () => {
    let now = 0
    const permit = createWidgetRateLimiter(() => now)
    for (let i = 0; i < 40; i += 1) expect(permit()).toBe(true)
    expect(permit()).toBe(false)
    now = 1000
    expect(permit()).toBe(true)
  })
  it('bounds untrusted JSON before serialization, including Unicode, escapes and sparse arrays', () => {
    for (const value of [null, true, false, 123, '中文🙂', '\ud800', '\udc00', '\ud800x\udc00', '\u0001\n"\\', [null, 1], { hello: 'world' }, new Array(3)]) {
      const bytes = Buffer.byteLength(JSON.stringify(value))
      expect(isBoundedWidgetJson(value, bytes)).toBe(true)
      expect(isBoundedWidgetJson(value, bytes - 1)).toBe(false)
    }
    expect(isBoundedWidgetJson([], 1)).toBe(false)
    expect(isBoundedWidgetJson({ jsonrpc: '2.0', params: 'x'.repeat(1024 * 1024) }, 24 * 1024)).toBe(false)
    expect(isBoundedWidgetJson(new Uint8Array(1024 * 1024), 24 * 1024)).toBe(false)
  })
})

describe('viewport frame pool', () => {
  it('a stale release cannot remove a replacement lease for the same owner', () => {
    const pool = new WidgetFramePool(1, 1)
    const oldStates: boolean[] = [], newStates: boolean[] = []
    const releaseOld = pool.acquire('owner', 'old-panel', granted => oldStates.push(granted))
    const releaseNew = pool.acquire('owner', 'new-panel', granted => newStates.push(granted))
    expect(oldStates).toEqual([true, false])
    expect(newStates).toEqual([true])
    releaseOld()
    expect(pool.activeCount).toBe(1)
    expect(newStates).toEqual([true])
    releaseNew()
    expect(pool.activeCount).toBe(0)
    expect(newStates).toEqual([true, false])
  })
  it('bounds every panel and promotes waiters when an owner leaves', () => {
    const pool = new WidgetFramePool(6, 3)
    const states = new Map<string, boolean>()
    const releases: (() => void)[] = []
    for (let index = 0; index < 100; index += 1) {
      const id = String(index)
      releases.push(pool.acquire(id, index < 50 ? 'left' : 'right', value => states.set(id, value)))
    }
    expect(pool.activeCount).toBe(6)
    expect(states.get('3')).not.toBe(true)
    releases[0]()
    expect(states.get('3')).toBe(true)
    expect(pool.activeCount).toBe(6)
    releases.forEach(release => release())
    expect(pool.activeCount).toBe(0)
  })
})


describe('stored render failure diagnosis', () => {
  it.each([
    ['invalid_widget: /values/999 (unknown_country_id) absent from topology', 'invalid_widget_unknown_country_id_999'],
    ['invalid_widget: /values/076 (invalid_country_value) expected a number', 'invalid_widget_invalid_country_value_076'],
    ['invalid_widget: /values/BR (invalid_country_id) expected numeric code', 'invalid_widget_invalid_country_id'],
    ['resource_blocked: verified world topology is unavailable', 'resource_blocked'],
    ['widget_quota: /values (country_limit) at most 300 entries', 'widget_quota_country_limit'],
    ['unclassified error with private or arbitrary text', 'render_failed'],
    ['invalid_widget: / (' + 'a'.repeat(49) + ') too long', 'invalid_widget'],
  ])('retains a bounded code for %s', (message, code) => {
    expect(widgetRenderErrorCode(message)).toBe(code)
    expect(code.length).toBeLessThanOrEqual(64)
    expect(code).toMatch(/^[a-z0-9_]+$/)
  })
})
