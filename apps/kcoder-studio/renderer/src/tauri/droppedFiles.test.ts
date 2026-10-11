import { describe, it, expect, vi, beforeEach } from 'vitest'
import { readSelectedDeliveryFiles } from './droppedFiles'
const native = vi.hoisted(() => ({ invoke: vi.fn() }))
vi.mock('@tauri-apps/api/core', () => native)
beforeEach(() => {
  native.invoke.mockReset()
})
describe('bounded native selected-file transfer', () => {
  it('reads metadata before binary chunks and closes the handle', async () => {
    native.invoke.mockImplementation(async method => {
      if (method === 'begin_dropped_file_read')
        return {
          readId: 'owned',
          chunkBytes: 262144,
          files: [{ name: 'a.txt', relativePath: 'dir/a.txt', size: 3 }],
        }
      if (method === 'read_dropped_file_chunk') return new Uint8Array([97, 98, 99]).buffer
      if (method === 'cancel_dropped_file_read') return undefined
      throw new Error(`Old whole-file JSON transfer is unsupported: ${method}`)
    })
    const result = await readSelectedDeliveryFiles(['/owned/dir'])
    expect(result[0].file.size).toBe(3)
    expect(result[0].relativePath).toBe('dir/a.txt')
    expect(native.invoke.mock.calls.map(call => call[0])).toEqual([
      'begin_dropped_file_read',
      'read_dropped_file_chunk',
      'cancel_dropped_file_read',
    ])
  })
  it('propagates cancellation and always releases native handles', async () => {
    const controller = new AbortController()
    native.invoke.mockImplementation(async method => {
      if (method === 'begin_dropped_file_read')
        return {
          readId: 'owned',
          chunkBytes: 262144,
          files: [{ name: 'a.bin', relativePath: 'a.bin', size: 600000 }],
        }
      if (method === 'read_dropped_file_chunk') {
        controller.abort()
        return new ArrayBuffer(262144)
      }
    })
    await expect(
      readSelectedDeliveryFiles(['/owned/file'], { signal: controller.signal })
    ).rejects.toMatchObject({ name: 'AbortError' })
    expect(
      native.invoke.mock.calls.filter(call => call[0] === 'read_dropped_file_chunk')
    ).toHaveLength(1)
    expect(native.invoke.mock.calls.some(call => call[0] === 'cancel_dropped_file_read')).toBe(true)
  })
})

it('older Native reports upgrade without falling back to whole-file JSON', async () => {
  native.invoke.mockRejectedValue('Command begin_dropped_file_read not found')
  await expect(readSelectedDeliveryFiles(['/owned/file'])).rejects.toThrow(
    /updated desktop application/
  )
  expect(native.invoke.mock.calls.some(call => call[0] === 'read_dropped_files')).toBe(false)
})
it('metadata over budget never reaches a chunk read', async () => {
  native.invoke.mockImplementation(async method => {
    if (method === 'begin_dropped_file_read')
      return {
        readId: 'owned',
        chunkBytes: 262144,
        files: [{ name: 'oversized', relativePath: 'oversized', size: 104857601 }],
      }
  })
  await expect(readSelectedDeliveryFiles(['/owned/file'])).rejects.toThrow(/size budget/)
  expect(native.invoke.mock.calls.some(call => call[0] === 'read_dropped_file_chunk')).toBe(false)
})
