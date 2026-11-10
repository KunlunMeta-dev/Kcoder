import { webcrypto, createHash } from 'node:crypto'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { widgetContentSha256 } from './contentHash'

afterEach(() => vi.unstubAllGlobals())
describe('widget SHA-256 integrity', () => {
  for (const subtle of [true, false]) {
    it(`matches independent known vectors with SubtleCrypto ${subtle ? 'available' : 'unavailable'}`, async () => {
      vi.stubGlobal('crypto', subtle ? webcrypto : {})
      for (const source of ['', 'abc', '中文与emoji🙂', 'x'.repeat(1024 * 1024)]) {
        expect(await widgetContentSha256(new TextEncoder().encode(source))).toBe(createHash('sha256').update(source).digest('hex'))
      }
    })
  }
})
