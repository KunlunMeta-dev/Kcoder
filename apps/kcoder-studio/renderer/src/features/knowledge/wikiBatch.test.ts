import { describe, expect, it, vi } from 'vitest'
import { runWikiBatch, type BatchEntry } from './wikiBatch'

describe('Wiki batch upload and organization', () => {
  it('continues after failure and retries organization without uploading again', async () => {
    const upload = vi.fn(async (item: string) => `source:${item}`)
    const organize = vi.fn(async (source: string) => {
      if (source === 'source:bad') throw new Error('queue unavailable')
    })
    const entries: BatchEntry<string, string>[] = ['first', 'bad', 'last'].map(item => ({
      item,
      status: 'pending',
    }))
    const options = { current: () => true, upload, organize, changed: vi.fn() }
    const result = await runWikiBatch(entries, options)
    expect(result.map(item => item.status)).toEqual(['queued', 'failed', 'queued'])
    expect(result[1].source).toBe('source:bad')
    organize.mockImplementation(async () => {})
    const retried = await runWikiBatch(result, options)
    expect(upload).toHaveBeenCalledTimes(3)
    expect(organize).toHaveBeenCalledTimes(4)
    expect(retried.every(item => item.status === 'queued')).toBe(true)
  })
  it('does not organize or upload more files after the target changes', async () => {
    let active = true
    const upload = vi.fn(async () => {
      active = false
      return 'source'
    })
    const organize = vi.fn(async () => {})
    await runWikiBatch(
      [
        { item: 'a', status: 'pending' },
        { item: 'b', status: 'pending' },
      ],
      {
        current: () => active,
        upload,
        organize,
        changed: vi.fn(),
      }
    )
    expect(upload).toHaveBeenCalledTimes(1)
    expect(organize).not.toHaveBeenCalled()
  })
  it('continues past an upload failure and retries only that file', async () => {
    const upload = vi.fn(async (item: string) => {
      if (item === 'bad') throw new Error('invalid file')
      return item
    })
    const options = {
      current: () => true,
      upload,
      organize: vi.fn(async () => {}),
      changed: vi.fn(),
    }
    const result = await runWikiBatch(
      [
        { item: 'bad', status: 'pending' },
        { item: 'good', status: 'pending' },
      ],
      options
    )
    expect(result.map(entry => entry.status)).toEqual(['failed', 'queued'])
    upload.mockImplementation(async item => item)
    await runWikiBatch(result, options)
    expect(upload).toHaveBeenCalledTimes(3)
    expect(options.organize).toHaveBeenCalledTimes(2)
  })
})
