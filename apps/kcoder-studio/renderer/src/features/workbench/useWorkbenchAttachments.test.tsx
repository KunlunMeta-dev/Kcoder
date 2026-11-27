import { act, renderHook, waitFor } from '@testing-library/react'
import { afterEach, expect, test, vi } from 'vitest'
import { useWorkbenchAttachments } from './useWorkbenchAttachments'
import type { Attachment } from '@/types/api'
import * as imageValidation from '@/lib/imageValidation'

afterEach(() => vi.restoreAllMocks())

test.each([['image.png', 'image.png'], ['first.png', 'second.png']])('images %s and %s stay independent and preserve selection order when uploads finish backwards', async (first, second) => {
  vi.spyOn(imageValidation, 'inspectImageFile').mockResolvedValue({ image_width: 100, image_height: 100 })
  const pending: { signal?: AbortSignal; resolve: (attachment: Attachment) => void }[] = []
  const upload = vi.fn((_file, _progress, signal) => new Promise<Attachment>(resolve => pending.push({ signal, resolve })))
  const { result } = renderHook(() => useWorkbenchAttachments({ uploadAttachment: upload }))
  let selected!: Promise<void>
  act(() => {
    selected = result.current.handleFileSelect([
      new File(['first'], first, { type: 'image/png' }),
      new File(['second'], second, { type: 'image/png' }),
    ])
  })
  await waitFor(() => expect(upload).toHaveBeenCalledTimes(2))
  expect(pending.every(upload => !upload.signal?.aborted)).toBe(true)
  expect(result.current.uploadingFiles.size).toBe(2)
  await act(async () => pending[1].resolve({ id: -2, filename: 'image.png', status: 'ready' } as Attachment))
  expect(result.current.isAttachmentReadyToSend).toBe(false)
  await act(async () => {
    pending[0].resolve({ id: -1, filename: 'image.png', status: 'ready' } as Attachment)
    await selected
  })
  expect(result.current.attachments.map(attachment => attachment.id)).toEqual([-1, -2])
  expect(result.current.isAttachmentReadyToSend).toBe(true)
})

test('cancelling one same-named upload does not abort its peer or publish a late result', async () => {
  const pending: { signal?: AbortSignal; resolve: (attachment: Attachment) => void }[] = []
  const upload = vi.fn((_file, _progress, signal) => new Promise<Attachment>(resolve => pending.push({ signal, resolve })))
  const { result } = renderHook(() => useWorkbenchAttachments({ uploadAttachment: upload }))
  let selected!: Promise<void>
  act(() => {
    selected = result.current.handleFileSelect([new File(['one'], 'same.txt'), new File(['two'], 'same.txt')])
  })
  await waitFor(() => expect(upload).toHaveBeenCalledTimes(2))
  act(() => result.current.cancelUpload([...result.current.uploadingFiles.keys()][0]))
  expect(pending[0].signal?.aborted).toBe(true)
  expect(pending[1].signal?.aborted).toBe(false)
  await act(async () => {
    pending[1].resolve({ id: -2, filename: 'same.txt', status: 'ready' } as Attachment)
    pending[0].resolve({ id: -1, filename: 'same.txt', status: 'ready' } as Attachment)
    await selected
  })
  expect(result.current.attachments.map(a => a.id)).toEqual([-2])
  expect(result.current.isAttachmentReadyToSend).toBe(true)
})

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
    pending = result.current.handleFileSelect(
      new File(['text'], 'same.txt', { type: 'text/plain' })
    )
  })
  await waitFor(() => expect(upload).toHaveBeenCalledTimes(1))
  act(() => resetDraft())
  expect(signal?.aborted).toBe(false)
  await act(async () => {
    resolve({ id: -1, filename: 'same.txt', status: 'ready' } as Attachment)
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

test('oversized image is reported before invoking the attachment upload transport', async () => {
  const upload = vi.fn()
  const { result } = renderHook(() => useWorkbenchAttachments({ uploadAttachment: upload }))
  const file = new File(['fixture'], 'large.png', { type: 'image/png' })
  Object.defineProperty(file, 'size', { value: 11 * 1024 * 1024 })
  await act(async () => {
    await result.current.handleFileSelect(file)
  })
  expect(upload).not.toHaveBeenCalled()
  expect(result.current.isAttachmentReadyToSend).toBe(false)
  expect([...result.current.errors.values()]).toEqual([
    expect.objectContaining({ filename: 'large.png' }),
  ])
})
