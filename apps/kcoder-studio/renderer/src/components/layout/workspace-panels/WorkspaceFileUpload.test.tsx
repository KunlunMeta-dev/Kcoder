import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { expect, test, vi } from 'vitest'
import userEvent from '@testing-library/user-event'
import '@/i18n'
import { notifyAccountContextChange } from '@/kcoder/accountContextEvents'
import { WorkspaceFileUpload } from './WorkspaceFileUpload'
import type { WorkspaceUploadResult } from '@/types/workspace-files'

const target = {
  deviceId: 'component-upload-device',
  path: '/workspace',
  source: 'project' as const,
}
const result: WorkspaceUploadResult = {
  status: 'uploaded',
  path: '/workspace/first/owned.txt',
  name: 'owned.txt',
  size: 4,
  sha256: 'a'.repeat(64),
  revision: null,
}
test('a later connection failure preserves confirmed batch count and remains dismissible', async () => {
  const upload = vi
    .fn()
    .mockResolvedValueOnce(result)
    .mockRejectedValueOnce(new Error('connection lost'))
  render(
    <WorkspaceFileUpload
      target={target}
      parentPath="/workspace/first"
      upload={upload}
      onUploaded={vi.fn()}
    />
  )
  fireEvent.change(screen.getByTestId('workspace-upload-input'), {
    target: {
      files: [new File(['test'], 'owned.txt'), new File(['next'], 'next.txt')],
    },
  })
  await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent(/已上传 1|Uploaded 1/))
  expect(screen.getByRole('alert')).toHaveTextContent('next.txt: connection lost')
  expect(screen.getByTestId('workspace-upload-destination')).toHaveTextContent('/workspace/first')
  await userEvent.click(screen.getByTestId('workspace-upload-dismiss'))
  expect(screen.queryByTestId('workspace-upload-status')).not.toBeInTheDocument()
})

test('Escape cancels overwrite and restores the upload trigger after asynchronous cleanup', async () => {
  let cleaned!: () => void
  const cleanup = new Promise<void>(resolve => {
    cleaned = resolve
  })
  const upload = vi.fn(async (_device, _workspace, _parent, _file, options) => {
    await options.onConflict({ ...result, status: 'conflict', revision: 'stat:owned' })
    await cleanup
    throw new DOMException('cancelled', 'AbortError')
  })
  render(
    <WorkspaceFileUpload
      target={target}
      parentPath="/workspace/first"
      upload={upload}
      onUploaded={vi.fn()}
    />
  )
  screen.getByTestId('workspace-upload-button').focus()
  select()
  await screen.findByRole('dialog')
  await userEvent.keyboard('{Escape}')
  expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
  expect(screen.getByTestId('workspace-upload-button')).toBeDisabled()
  await act(async () => cleaned())
  await waitFor(() => expect(screen.getByTestId('workspace-upload-button')).toHaveFocus())
})
function select() {
  fireEvent.change(screen.getByTestId('workspace-upload-input'), {
    target: { files: [new File(['test'], 'owned.txt')] },
  })
}

test('refresh failure keeps the committed upload successful and the captured destination visible', async () => {
  let finish!: (result: WorkspaceUploadResult) => void
  const upload = vi.fn(
    () =>
      new Promise<WorkspaceUploadResult>(resolve => {
        finish = resolve
      })
  )
  const refresh = vi.fn().mockRejectedValue(new Error('refresh transport failed'))
  const view = render(
    <WorkspaceFileUpload
      target={target}
      parentPath="/workspace/first"
      upload={upload}
      onUploaded={refresh}
    />
  )
  select()
  view.rerender(
    <WorkspaceFileUpload
      target={target}
      parentPath="/workspace/second"
      upload={upload}
      onUploaded={refresh}
    />
  )
  expect(screen.getByTestId('workspace-upload-destination')).toHaveTextContent('/workspace/first')
  await act(async () => finish(result))
  await waitFor(() =>
    expect(screen.getByTestId('workspace-upload-status')).toHaveTextContent(/已上传 1|Uploaded 1/)
  )
  expect(screen.getByTestId('workspace-upload-refresh-error')).toHaveTextContent(
    /文件已保存|Files were saved/
  )
  expect(screen.getByTestId('workspace-upload-status')).not.toHaveTextContent(
    /上传未完成|Upload incomplete/
  )
  expect(refresh).toHaveBeenCalledWith(result, '/workspace/first')
})

test.each(['target', 'account'])(
  '%s changes abort pending uploads and suppress old completion callbacks',
  async change => {
    let finish!: (result: WorkspaceUploadResult) => void
    let signal!: AbortSignal
    const upload = vi.fn((_device, _workspace, _parent, _file, options) => {
      signal = options.signal
      return new Promise<WorkspaceUploadResult>(resolve => {
        finish = resolve
      })
    })
    const refresh = vi.fn()
    const view = render(
      <WorkspaceFileUpload
        target={target}
        parentPath="/workspace/first"
        upload={upload}
        onUploaded={refresh}
      />
    )
    select()
    if (change === 'target')
      view.rerender(
        <WorkspaceFileUpload
          target={{ ...target, path: '/other' }}
          parentPath="/other"
          upload={upload}
          onUploaded={refresh}
        />
      )
    else act(() => notifyAccountContextChange(target.deviceId))
    expect(signal.aborted).toBe(true)
    await act(async () => finish(result))
    expect(refresh).not.toHaveBeenCalled()
    expect(screen.queryByTestId('workspace-upload-status')).not.toBeInTheDocument()
  }
)

test('retry sends only remaining files to the original folder and keeps cumulative receipts', async () => {
  const files = [
    new File(['one'], 'owned.txt'),
    new File(['two'], 'second.txt'),
    new File(['three'], 'third.txt'),
  ]
  const upload = vi
    .fn()
    .mockResolvedValueOnce(result)
    .mockRejectedValueOnce(new Error('offline'))
    .mockResolvedValue({ ...result, name: 'second.txt' })
  const refreshed = vi.fn()
  const view = render(
    <WorkspaceFileUpload
      target={target}
      parentPath="/workspace/first"
      upload={upload}
      onUploaded={refreshed}
    />
  )
  fireEvent.change(screen.getByTestId('workspace-upload-input'), { target: { files } })
  await screen.findByRole('alert')
  expect(upload).toHaveBeenCalledTimes(2)
  view.rerender(
    <WorkspaceFileUpload
      target={target}
      parentPath="/workspace/second"
      upload={upload}
      onUploaded={refreshed}
    />
  )
  await userEvent.click(screen.getByTestId('workspace-upload-retry'))
  await waitFor(() =>
    expect(screen.getByTestId('workspace-upload-status')).toHaveTextContent(/已上传 3|Uploaded 3/)
  )
  expect(upload.mock.calls.map(call => call[3].name)).toEqual([
    'owned.txt',
    'second.txt',
    'second.txt',
    'third.txt',
  ])
  expect(upload.mock.calls.map(call => call[2])).toEqual(Array(4).fill('/workspace/first'))
  expect(refreshed).toHaveBeenCalledTimes(3)
  expect(screen.queryByTestId('workspace-upload-retry')).toBeNull()
})

test('cancel feedback remains honest while cleanup and a late progress callback are pending', async () => {
  let reject!: (cause: Error) => void
  let progress!: (sent: number, total: number) => void
  const upload = vi.fn((_device, _workspace, _parent, _file, options) => {
    progress = options.onProgress
    return new Promise<WorkspaceUploadResult>((_, fail) => {
      reject = fail
    })
  })
  render(
    <WorkspaceFileUpload
      target={target}
      parentPath="/workspace/first"
      upload={upload}
      onUploaded={vi.fn()}
    />
  )
  select()
  await userEvent.click(screen.getByTestId('workspace-upload-dismiss'))
  expect(screen.getByTestId('workspace-upload-status')).toHaveTextContent(/正在取消|Cancelling/)
  expect(screen.getByTestId('workspace-upload-dismiss')).toBeDisabled()
  act(() => progress(4, 4))
  expect(screen.getByTestId('workspace-upload-status')).toHaveTextContent(/正在取消|Cancelling/)
  await act(async () => reject(new DOMException('cancelled', 'AbortError')))
  await waitFor(() => expect(screen.getByTestId('workspace-upload-button')).toBeEnabled())
  expect(screen.queryByTestId('workspace-upload-retry')).toBeNull()
})

test('cancel during directory refresh preserves the committed receipt and stops the next file', async () => {
  let finish!: () => void
  const refresh = vi.fn(
    () =>
      new Promise<void>(resolve => {
        finish = resolve
      })
  )
  const upload = vi.fn(async (_device, _workspace, _parent, _file, options) => {
    options.onPhase('saving')
    return result
  })
  render(
    <WorkspaceFileUpload
      target={target}
      parentPath="/workspace/first"
      upload={upload}
      onUploaded={refresh}
    />
  )
  fireEvent.change(screen.getByTestId('workspace-upload-input'), {
    target: { files: [new File(['one'], 'owned.txt'), new File(['two'], 'second.txt')] },
  })
  await waitFor(() => expect(refresh).toHaveBeenCalledTimes(1))
  expect(screen.getByTestId('workspace-upload-dismiss')).toBeEnabled()
  await userEvent.click(screen.getByTestId('workspace-upload-dismiss'))
  await act(async () => finish())
  await waitFor(() =>
    expect(screen.getByTestId('workspace-upload-status')).toHaveTextContent(/已取消|cancelled/i)
  )
  expect(screen.getByTestId('workspace-upload-status')).toHaveTextContent('1')
  expect(upload).toHaveBeenCalledTimes(1)
})

test.each(['target', 'account'] as const)(
  'a failed queue cannot be retried after %s changes',
  async change => {
    const upload = vi.fn().mockRejectedValue(new Error('offline'))
    const view = render(
      <WorkspaceFileUpload
        target={target}
        parentPath="/workspace/first"
        upload={upload}
        onUploaded={vi.fn()}
      />
    )
    select()
    await screen.findByTestId('workspace-upload-retry')
    if (change === 'account') act(() => notifyAccountContextChange(target.deviceId))
    else
      view.rerender(
        <WorkspaceFileUpload
          target={{ ...target, path: '/other' }}
          parentPath="/other"
          upload={upload}
          onUploaded={vi.fn()}
        />
      )
    expect(screen.queryByTestId('workspace-upload-retry')).toBeNull()
    expect(screen.queryByTestId('workspace-upload-status')).toBeNull()
    expect(upload).toHaveBeenCalledTimes(1)
  }
)
