import { act, renderHook, waitFor } from '@testing-library/react'
import { expect, test, vi } from 'vitest'
import { useWorkbenchAttachments } from './useWorkbenchAttachments'
import type { Attachment } from '@/types/api'

test('a stale scope reset cannot cancel an upload in the newly opened conversation', async () => {
  let signal: AbortSignal | undefined
  let resolve!: (attachment: Attachment) => void
  const upload = vi.fn((_file, _progress, uploadSignal) => {
    signal = uploadSignal
    return new Promise<Attachment>(done => {
      resolve = done
    })
  })
  const { result, rerender } = renderHook(
    ({ scope }) => useWorkbenchAttachments({ scopeKey: scope, uploadAttachment: upload }),
    { initialProps: { scope: 'draft' } }
  )
  const resetDraft = result.current.resetAttachments
  rerender({ scope: 'thread' })
  let pending!: Promise<void>
  act(() => {
    pending = result.current.handleFileSelect(new File(['png'], 'same.png', { type: 'image/png' }))
  })
  await waitFor(() => expect(upload).toHaveBeenCalledTimes(1))
  act(() => resetDraft())
  expect(signal?.aborted).toBe(false)
  await act(async () => {
    resolve({ id: -1, filename: 'same.png', status: 'ready' } as Attachment)
    await pending
  })
  expect(result.current.attachments).toHaveLength(1)
  expect(result.current.isUploading).toBe(false)
})

test('a send acknowledgement only consumes its submitted attachments', () => {
  const { result } = renderHook(() => useWorkbenchAttachments())
  act(() =>
    result.current.addExistingAttachment({
      id: -1,
      filename: 'submitted.png',
      status: 'ready',
    } as Attachment)
  )
  const consume = result.current.resetAttachments
  act(() =>
    result.current.addExistingAttachment({
      id: -2,
      filename: 'next.png',
      status: 'ready',
    } as Attachment)
  )
  act(() => consume([-1]))
  expect(result.current.attachments.map(attachment => attachment.id)).toEqual([-2])
})
