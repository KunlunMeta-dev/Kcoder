import { describe, expect, test } from 'vitest'
import { blobBytes } from './blobBytes'

function readBytes(file: File): Promise<Uint8Array> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onerror = () => reject(reader.error)
    reader.onload = () => {
      if (typeof reader.result === 'string' || reader.result === null) {
        reject(new Error('Expected binary File content'))
        return
      }
      resolve(new Uint8Array(reader.result))
    }
    reader.readAsArrayBuffer(file)
  })
}

describe('workspace binary File parts', () => {
  test('reuses owned backing while preserving the exact nonzero byte range', async () => {
    const backing = new Uint8Array([99, 10, 20, 30, 77])
    const bytes = backing.subarray(1, 4)
    const part = blobBytes(bytes)
    expect(part.buffer).toBe(backing.buffer)
    expect(part.byteOffset).toBe(bytes.byteOffset)
    expect(part.byteLength).toBe(3)
    const file = new File([part], 'range.bin')
    expect([...(await readBytes(file))]).toEqual([10, 20, 30])
  })

  test('copies a SharedArrayBuffer range into bytes accepted by File', async () => {
    const backing = new SharedArrayBuffer(6)
    const source = new Uint8Array(backing)
    source.set([99, 10, 20, 30, 40, 77])
    const part = blobBytes(source.subarray(1, 5))
    expect(part.buffer).toBeInstanceOf(ArrayBuffer)
    expect(part.buffer).not.toBe(backing)
    source.fill(0)
    expect([...part]).toEqual([10, 20, 30, 40])
    const file = new File([part], 'shared.bin')
    expect([...(await readBytes(file))]).toEqual([10, 20, 30, 40])
  })

  test('File snapshots all parts before later source changes', async () => {
    const first = new Uint8Array([99, 1, 2, 77])
    const second = new Uint8Array([3, 4])
    const file = new File([blobBytes(first.subarray(1, 3)), blobBytes(second)], 'snapshot.bin')
    first.fill(0)
    second.fill(0)
    expect([...(await readBytes(file))]).toEqual([1, 2, 3, 4])
  })
})
