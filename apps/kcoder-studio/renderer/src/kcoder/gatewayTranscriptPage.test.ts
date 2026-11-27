import { expect, test, vi } from 'vitest'
import { requestTranscriptPage } from './gatewayTranscriptPage'

test('indexed stale cursor reloads once and explicitly resets accumulated history', async () => {
  const request = vi
    .fn()
    .mockRejectedValueOnce(new Error('TRANSCRIPT_CURSOR_STALE'))
    .mockResolvedValueOnce({ messages: [] })
  const result = await requestTranscriptPage(
    { supportsExperimental: () => true, request },
    { threadId: 'thread', beforeCursor: 'tp1:old:10', limit: 50 }
  )
  expect(result.historyReset).toBe(true)
  expect(request.mock.calls).toEqual([
    ['thread/read/indexed', { threadId: 'thread', beforeCursor: 'tp1:old:10', limit: 50 }],
    ['thread/read/indexed', { threadId: 'thread', limit: 50 }],
  ])
})

test('downgrade never sends an opaque cursor to a legacy server', async () => {
  const request = vi.fn().mockResolvedValue({ messages: [] })
  expect(
    (
      await requestTranscriptPage(
        { supportsExperimental: () => false, request },
        { threadId: 't', beforeCursor: 'tp1:old:1' }
      )
    ).historyReset
  ).toBe(true)
  expect(request).toHaveBeenCalledExactlyOnceWith('thread/read', { threadId: 't' })
})

test('failed fresh reload does not loop and unrelated errors do not retry', async () => {
  const request = vi
    .fn()
    .mockRejectedValueOnce(new Error('TRANSCRIPT_CURSOR_STALE'))
    .mockRejectedValue(new Error('offline'))
  await expect(
    requestTranscriptPage(
      { supportsExperimental: () => true, request },
      { beforeCursor: 'tp1:old:1' }
    )
  ).rejects.toThrow('offline')
  expect(request).toHaveBeenCalledTimes(2)
  request.mockClear()
  await expect(requestTranscriptPage({ request }, { beforeCursor: '5' })).rejects.toThrow('offline')
  expect(request).toHaveBeenCalledTimes(1)
})
