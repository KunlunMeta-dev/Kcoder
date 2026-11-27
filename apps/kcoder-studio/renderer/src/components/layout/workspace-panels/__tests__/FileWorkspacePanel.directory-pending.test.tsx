import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { expect, test, vi } from 'vitest'
import '@/i18n'
import { FileWorkspacePanel } from '../FileWorkspacePanel'
import type { WorkspaceFileChunkResponse, WorkspaceFileEntry } from '@/types/workspace-files'

vi.mock('@/lib/local-terminal', () => ({ isLocalTerminalAvailable: () => false }))
vi.mock('../WorkspaceFileTree', () => ({
  WorkspaceFileTree: (props: {
    onOpenDirectory: (entry: WorkspaceFileEntry) => void
    onOpenFile: (entry: WorkspaceFileEntry) => void
  }) => (
    <div>
      <button
        onClick={() =>
          props.onOpenDirectory({ name: 'src', path: '/workspace/src', isDirectory: true, size: 0 })
        }
      >
        Open directory
      </button>
      <button
        onClick={() =>
          props.onOpenFile({
            name: 'next.png',
            path: '/workspace/next.png',
            isDirectory: false,
            size: 2,
          })
        }
      >
        Open next file
      </button>
    </div>
  ),
}))
vi.mock('../WorkspaceFilePreview', () => ({
  WorkspaceFilePreview: (props: {
    loading: boolean
    loadingProgress: unknown
    binaryFile: { file: File } | null
    error: string | null
  }) => (
    <div>
      {props.loading ? <p role="status">Loading</p> : <p>Idle preview</p>}
      {props.loadingProgress !== null && <p>Download progress</p>}
      {props.binaryFile && <p>{props.binaryFile.file.name}</p>}
      {props.error && <p role="alert">{props.error}</p>}
    </div>
  ),
}))

test.each(['success', 'failure'])(
  'directory navigation ends pending loading and ignores a late %s before opening another file',
  async outcome => {
    let finish!: (chunk: WorkspaceFileChunkResponse) => void
    let fail!: (error: Error) => void
    const first: WorkspaceFileChunkResponse = {
      path: '/workspace/preview.pdf',
      name: 'preview.pdf',
      size: 4,
      modifiedAt: '1000',
      offset: 0,
      contentBase64: 'AQI=',
      eof: false,
    }
    const read = vi
      .fn()
      .mockResolvedValueOnce(first)
      .mockReturnValueOnce(
        new Promise<WorkspaceFileChunkResponse>((resolve, reject) => {
          finish = resolve
          fail = reject
        })
      )
      .mockResolvedValueOnce({
        ...first,
        path: '/workspace/next.png',
        name: 'next.png',
        size: 2,
        eof: true,
      })
    render(
      <FileWorkspacePanel
        target={{ deviceId: 'device', path: '/workspace', source: 'runtime' }}
        workspaceFileApi={{
          listWorkspaceEntries: vi.fn(async () => ({ path: '/workspace', entries: [] })),
          readWorkspaceTextFile: vi.fn(),
          readWorkspaceFileChunk: read,
        }}
        onAddCodeComment={vi.fn()}
        openFileRequest={{ id: 1, path: 'preview.pdf' }}
      />
    )
    await waitFor(() => expect(read).toHaveBeenCalledTimes(2))
    expect(screen.getByRole('status')).toHaveTextContent('Loading')
    expect(screen.getByText('Download progress')).toBeInTheDocument()
    await act(async () => fireEvent.click(screen.getByText('Open directory')))
    expect(screen.queryByRole('status')).not.toBeInTheDocument()
    expect(screen.queryByText('Download progress')).not.toBeInTheDocument()
    expect(screen.getByTestId('workspace-file-path')).toHaveTextContent('/workspace/src')
    await act(async () => {
      if (outcome === 'success') finish({ ...first, offset: 2, eof: true })
      else fail(new Error('late read failed'))
    })
    expect(screen.queryByRole('status')).not.toBeInTheDocument()
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
    expect(screen.queryByText('preview.pdf')).not.toBeInTheDocument()
    await act(async () => fireEvent.click(screen.getByText('Open next file')))
    expect(await screen.findByText('next.png')).toBeInTheDocument()
    expect(screen.queryByRole('status')).not.toBeInTheDocument()
    expect(read).toHaveBeenCalledTimes(3)
  }
)
