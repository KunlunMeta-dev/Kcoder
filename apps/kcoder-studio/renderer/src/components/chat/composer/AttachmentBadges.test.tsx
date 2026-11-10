import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { expect, test, vi } from 'vitest'
import { useWorkbenchAttachments } from '@/features/workbench/useWorkbenchAttachments'
import type { Attachment } from '@/types/api'
import { AttachmentBadges } from './AttachmentBadges'

test('an oversized composer attachment can be dismissed and no longer blocks sending', async () => {
  const upload = vi.fn()
  const file = new File(['fixture'], 'large.csv', { type: 'text/csv' })
  Object.defineProperty(file, 'size', { value: 101 * 1024 * 1024 })
  const read = vi.spyOn(file, 'arrayBuffer')
  function Composer() {
    const attachments = useWorkbenchAttachments({ uploadAttachment: upload })
    return (
      <>
        <button onClick={() => void attachments.handleFileSelect(file)}>Select</button>
        <AttachmentBadges
          {...attachments}
          onRemoveAttachment={attachments.removeAttachment}
          onCancelUpload={attachments.cancelUpload}
        />
        <button disabled={!attachments.isAttachmentReadyToSend}>Send</button>
      </>
    )
  }
  render(<Composer />)
  fireEvent.click(screen.getByText('Select'))
  await screen.findByTestId('attachment-error-badge')
  expect(screen.getByText('Send')).toBeDisabled()
  expect(upload).not.toHaveBeenCalled()
  expect(read).not.toHaveBeenCalled()
  fireEvent.click(screen.getByTestId('dismiss-attachment-error'))
  expect(screen.queryByTestId('attachment-error-badge')).not.toBeInTheDocument()
  expect(screen.getByText('Send')).toBeEnabled()
})

test('cancelling an unresponsive upload releases the composer and ignores its late reply', async () => {
  let resolve!: (attachment: Attachment) => void
  let pending!: Promise<void>
  const upload = vi.fn(
    () =>
      new Promise<Attachment>(done => {
        resolve = done
      })
  )
  function Composer() {
    const attachments = useWorkbenchAttachments({ uploadAttachment: upload })
    return (
      <>
        <button
          onClick={() => {
            pending = attachments.handleFileSelect(new File(['fixture'], 'notes.txt'))
          }}
        >
          Select
        </button>
        <AttachmentBadges
          {...attachments}
          onRemoveAttachment={attachments.removeAttachment}
          onCancelUpload={attachments.cancelUpload}
        />
        <button disabled={!attachments.isAttachmentReadyToSend}>Send</button>
      </>
    )
  }
  render(<Composer />)
  fireEvent.click(screen.getByText('Select'))
  await waitFor(() => expect(upload).toHaveBeenCalledOnce())
  fireEvent.click(screen.getByTestId('cancel-upload-button'))
  await act(async () => {
    await pending
  })
  expect(screen.getByText('Send')).toBeEnabled()
  expect(screen.queryByTestId('uploading-attachment-badge')).not.toBeInTheDocument()
  await act(async () => {
    resolve({ id: -1, filename: 'notes.txt', status: 'ready' } as Attachment)
  })
  expect(screen.queryByTestId('attachment-badge')).not.toBeInTheDocument()
})
