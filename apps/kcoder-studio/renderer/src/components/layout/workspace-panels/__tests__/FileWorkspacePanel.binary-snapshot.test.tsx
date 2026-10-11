import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { expect, test, vi } from 'vitest'
import '@/i18n'
import { FileWorkspacePanel } from '../FileWorkspacePanel'
import type { WorkspaceFileChunkResponse } from '@/types/workspace-files'

vi.mock('@/lib/local-terminal', () => ({
  isLocalTerminalAvailable: () => false,
  listLocalFileOpeners: async () => ({ applications: [], default_path: null }),
}))
vi.mock('../WorkspaceFileTree', () => ({ WorkspaceFileTree: () => null }))
vi.mock('../WorkspaceFilePreview', () => ({
  WorkspaceFilePreview: (props: {
    binaryFile: { file: File } | null
    error: string | null
    onRetry: () => void
  }) => (
    <div>
      {props.binaryFile && <span data-testid="assembled-binary">{props.binaryFile.file.size}</span>}
      {props.error && (
        <>
          <p role="alert">{props.error}</p>
          <button onClick={props.onRetry}>Retry preview</button>
        </>
      )}
    </div>
  ),
}))

const first: WorkspaceFileChunkResponse = {
  path: '/workspace/preview.pdf',
  name: 'preview.pdf',
  size: 4,
  modifiedAt: '1000',
  offset: 0,
  contentBase64: 'AQI=',
  eof: false,
}
const last: WorkspaceFileChunkResponse = { ...first, offset: 2, contentBase64: 'AwQ=', eof: true }
function fixture(initial = first) {
  let finish!: (chunk: WorkspaceFileChunkResponse) => void
  const read = vi
    .fn()
    .mockResolvedValueOnce(initial)
    .mockReturnValueOnce(
      new Promise(resolve => {
        finish = resolve
      })
    )
  const api = {
    listWorkspaceEntries: vi.fn(async () => ({ path: '/workspace', entries: [] })),
    readWorkspaceTextFile: vi.fn(),
    readWorkspaceFileChunk: read,
  }
  const view = render(
    <FileWorkspacePanel
      target={{ deviceId: 'device', path: '/workspace', source: 'runtime' }}
      workspaceFileApi={api}
      onAddCodeComment={vi.fn()}
      openFileRequest={{ id: 1, path: 'preview.pdf' }}
    />
  )
  return { read, api, view, finish: (chunk: WorkspaceFileChunkResponse) => finish(chunk) }
}

test.each([
  { path: '/workspace/replaced.pdf' },
  { name: 'replaced.pdf' },
  { size: 5 },
  { modifiedAt: '1001' },
])('does not publish a binary preview when later chunk metadata changes: %j', async changed => {
  const host = fixture()
  await waitFor(() => expect(host.read).toHaveBeenCalledTimes(2))
  expect(screen.queryByTestId('assembled-binary')).not.toBeInTheDocument()
  await act(async () => host.finish({ ...last, ...changed }))
  expect(await screen.findByRole('alert')).toHaveTextContent(
    /文件在读取中已变化|changed while being read/
  )
  expect(screen.queryByTestId('assembled-binary')).not.toBeInTheDocument()
})

test.each([
  { offset: 1 },
  { offset: 3 },
  { contentBase64: '', eof: false },
  { contentBase64: '', eof: true },
  { contentBase64: 'AwQFBg==' },
  { eof: false },
])('rejects missing, overlapping or incomplete chunk progress: %j', async changed => {
  const host = fixture()
  await waitFor(() => expect(host.read).toHaveBeenCalledTimes(2))
  await act(async () => host.finish({ ...last, ...changed }))
  expect(await screen.findByRole('alert')).toHaveTextContent(
    /文件在读取中已变化|changed while being read/
  )
  expect(screen.queryByTestId('assembled-binary')).not.toBeInTheDocument()
  expect(host.read).toHaveBeenCalledTimes(2)
})

test('stable chunks remain readable, including older targets without modification metadata', async () => {
  const host = fixture({ ...first, modifiedAt: undefined })
  await waitFor(() => expect(host.read).toHaveBeenCalledTimes(2))
  await act(async () => host.finish({ ...last, modifiedAt: null }))
  expect(await screen.findByTestId('assembled-binary')).toHaveTextContent('4')
  expect(host.read.mock.calls.map(call => call[2])).toEqual([0, 2])
  expect(screen.queryByRole('alert')).not.toBeInTheDocument()
})

test('retry reads a new coherent snapshot after rejecting a changed file', async () => {
  const host = fixture()
  await waitFor(() => expect(host.read).toHaveBeenCalledTimes(2))
  await act(async () => host.finish({ ...last, modifiedAt: '1001' }))
  await screen.findByRole('alert')
  host.read
    .mockResolvedValueOnce({ ...first, modifiedAt: '1001' })
    .mockResolvedValueOnce({ ...last, modifiedAt: '1001' })
  fireEvent.click(screen.getByText('Retry preview'))
  expect(await screen.findByTestId('assembled-binary')).toHaveTextContent('4')
  expect(screen.queryByRole('alert')).not.toBeInTheDocument()
})

test('a complete empty binary file is not treated as stalled chunk progress', async () => {
  fixture({ ...first, size: 0, contentBase64: '', eof: true })
  expect(await screen.findByTestId('assembled-binary')).toHaveTextContent('0')
  expect(screen.queryByRole('alert')).not.toBeInTheDocument()
})

test.each(['opaque-replaced', undefined])(
  'does not mix equal-size, equal-ms chunks when an opaque revision changes or disappears: %s',
  async revision => {
    const host = fixture({ ...first, revision: 'opaque-first' })
    await waitFor(() => expect(host.read).toHaveBeenCalledTimes(2))
    await act(async () => host.finish({ ...last, revision }))
    expect(await screen.findByRole('alert')).toHaveTextContent(
      /文件在读取中已变化|changed while being read/
    )
    expect(screen.queryByTestId('assembled-binary')).not.toBeInTheDocument()
  }
)

test('pins every subsequent chunk to the first opaque revision', async () => {
  const host = fixture({ ...first, revision: 'opaque-first' })
  await waitFor(() => expect(host.read).toHaveBeenCalledTimes(2))
  expect(host.read).toHaveBeenNthCalledWith(
    2,
    'device',
    '/workspace/preview.pdf',
    2,
    'opaque-first'
  )
  await act(async () => host.finish({ ...last, revision: 'opaque-first' }))
  expect(await screen.findByTestId('assembled-binary')).toHaveTextContent('4')
})

test.each(['workspace_file_changed: rejected opened-file revision', 'Gateway connection closed'])(
  'distinguishes changed-file errors from connection loss: %s',
  async message => {
    const host = fixture()
    await waitFor(() => expect(host.read).toHaveBeenCalledTimes(2))
    await act(async () => host.finish({ ...last, size: 5 }))
    await screen.findByRole('alert')
    host.read.mockRejectedValueOnce(new Error(message))
    fireEvent.click(screen.getByText('Retry preview'))
    const alert = await screen.findByRole('alert')
    if (message.startsWith('workspace_file_changed:'))
      expect(alert).toHaveTextContent(/文件在读取中已变化|changed while being read/)
    else expect(alert).toHaveTextContent('Gateway connection closed')
    expect(screen.queryByTestId('assembled-binary')).not.toBeInTheDocument()
  }
)

test('a stale revision failure from the previous target cannot replace the current preview', async () => {
  const host = fixture({ ...first, revision: 'old-revision' })
  await waitFor(() => expect(host.read).toHaveBeenCalledTimes(2))
  host.read.mockResolvedValueOnce({
    ...first,
    eof: true,
    contentBase64: 'BQYHCA==',
    revision: 'new-revision',
  })
  host.view.rerender(
    <FileWorkspacePanel
      target={{ deviceId: 'other-device', path: '/workspace', source: 'runtime' }}
      workspaceFileApi={host.api}
      onAddCodeComment={vi.fn()}
      openFileRequest={{ id: 2, path: 'preview.pdf' }}
    />
  )
  expect(await screen.findByTestId('assembled-binary')).toHaveTextContent('4')
  expect(host.read).toHaveBeenNthCalledWith(
    3,
    'other-device',
    '/workspace/preview.pdf',
    0,
    undefined
  )
  await act(async () => host.finish({ ...last, revision: 'stale-changed-revision' }))
  expect(screen.getByTestId('assembled-binary')).toHaveTextContent('4')
  expect(screen.queryByRole('alert')).not.toBeInTheDocument()
})
