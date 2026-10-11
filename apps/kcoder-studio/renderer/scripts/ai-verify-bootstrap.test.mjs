import { readFileSync } from 'node:fs'
import { runInNewContext } from 'node:vm'
import { resolve } from 'node:path'
import { describe, expect, test } from 'vitest'

const config = {
  origin: 'http://127.0.0.1:1234',
  controlUrl: 'http://127.0.0.1:1235',
  token: 'a'.repeat(64),
}
const script = readFileSync(resolve('src-tauri/src/ai_verify_bootstrap.js'), 'utf8').replace(
  '__KCODER_VERIFY_CONFIG__',
  JSON.stringify(config)
)

function execute(origin, topLevel = true) {
  const calls = []
  const window = {
    __TAURI_INTERNALS__: {
      invoke: command => {
        calls.push(command)
        return Promise.reject(new Error('denied'))
      },
    },
    addEventListener() {},
  }
  window.top = topLevel ? window : {}
  runInNewContext(script, {
    window,
    location: { origin },
    document: { readyState: 'complete' },
    fetch: () => Promise.resolve({ ok: true }),
  })
  return { window, calls }
}

describe('native Gateway bootstrap', () => {
  test('does not inject credentials or attempt native calls in another origin or child frame', () => {
    for (const [origin, top] of [
      [config.controlUrl, true],
      ['https://example.com', true],
      [config.origin, false],
    ]) {
      const { window, calls } = execute(origin, top)
      expect(window.__KCODER_AI_VERIFY__).toBeUndefined()
      expect(calls).toEqual([])
    }
  })

  test('records only read-only native rejection probes and freezes its session config', async () => {
    const { window, calls } = execute(config.origin)
    expect(calls).toEqual(['get_app_preferences', 'plugin:window|is_visible'])
    expect(await window.__KCODER_AI_VERIFY__.nativeIsolation).toEqual([true, true])
    expect(Object.isFrozen(window.__KCODER_AI_VERIFY__)).toBe(true)
    expect(Object.getOwnPropertyDescriptor(window, '__KCODER_AI_VERIFY__').writable).toBe(false)
    expect(Object.getOwnPropertyDescriptor(window, '__KCODER_AI_VERIFY__').configurable).toBe(false)
  })
})
