import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { expect, test, vi } from 'vitest'
import '@/i18n'
import { FileWorkspacePanel } from '../FileWorkspacePanel'

vi.mock('@/lib/local-terminal', () => ({
  isLocalTerminalAvailable: () => false,
  getCachedLocalFileOpenerIcon: () => null,
  getLocalFileOpenerIcon: vi.fn(),
  listLocalFileOpeners: vi.fn(),
  openLocalFile: vi.fn(),
  openLocalFileWithApplication: vi.fn(),
  revealLocalFile: vi.fn(),
}))

const clipboardMock = vi.hoisted(() => ({ copyTextToClipboard: vi.fn() }))

vi.mock('@/lib/clipboard', () => ({ copyTextToClipboard: clipboardMock.copyTextToClipboard }))

const treeContextMenuMock = vi.hoisted(() => ({
  close: vi.fn(),
  entry: {
    name: 'a.ts',
    path: String.raw`\\?\C:\Users\kunlunmeta\projects\gpt-model-service\src\a.ts`,
    isDirectory: false,
    size: 1,
    modifiedAt: null as string | null,
  },
}))

vi.mock('../WorkspaceFilePreview', () => ({ WorkspaceFilePreview: () => null }))
vi.mock('../WorkspaceFileTree', () => ({
  WorkspaceFileTree: (props: {
    onEntryContextMenu?: (
      entry: typeof treeContextMenuMock.entry,
      position: { left: number; top: number },
      close: () => void
    ) => void
  }) => (
    <button
      type="button"
      data-testid="workspace-file-tree-context-trigger"
      onClick={() =>
        props.onEntryContextMenu?.(
          treeContextMenuMock.entry,
          { left: 10, top: 10 },
          treeContextMenuMock.close
        )
      }
    />
  ),
}))

function createWorkspaceFileApi() {
  return {
    listWorkspaceEntries: vi.fn().mockRejectedValue(new Error('tree unavailable in test')),
    searchWorkspaceEntries: vi.fn().mockResolvedValue({ files: [] }),
    readWorkspaceTextFile: vi.fn().mockResolvedValue({
      path: 'C:/Users/kunlunmeta/projects/gpt-model-service/src/registry.rs',
      name: 'registry.rs',
      content: 'fn main() {}',
      editable: true,
      revision: 'sha256:test',
      truncated: false,
      size: 12,
      modifiedAt: null,
    }),
    readWorkspaceFileChunk: vi.fn(),
    writeWorkspaceTextFile: vi.fn(),
    createWorkspaceTextFile: vi.fn(),
    createWorkspaceDirectory: vi.fn(),
    renameWorkspaceEntry: vi.fn(),
    deleteWorkspaceEntry: vi.fn(),
  }
}

const verbatimRoot = String.raw`\\?\C:\Users\kunlunmeta\projects\gpt-model-service`

test('opens a relative file request under a verbatim windows root as a clean path', async () => {
  const workspaceFileApi = createWorkspaceFileApi()

  render(
    <FileWorkspacePanel
      target={{ deviceId: 'device-1', path: verbatimRoot, source: 'runtime' }}
      workspaceFileApi={workspaceFileApi as never}
      openFileRequest={{ id: 1, path: 'src/registry.rs' }}
      onAddCodeComment={vi.fn()}
    />
  )

  await waitFor(() => {
    expect(workspaceFileApi.readWorkspaceTextFile).toHaveBeenCalledWith(
      'device-1',
      'C:/Users/kunlunmeta/projects/gpt-model-service/src/registry.rs'
    )
  })
})

test('opens an absolute verbatim windows file request without namespace prefixes', async () => {
  const workspaceFileApi = createWorkspaceFileApi()

  render(
    <FileWorkspacePanel
      target={{ deviceId: 'device-1', path: verbatimRoot, source: 'runtime' }}
      workspaceFileApi={workspaceFileApi as never}
      openFileRequest={{
        id: 2,
        path: String.raw`\\?\C:\Users\kunlunmeta\projects\gpt-model-service\src\registry.rs`,
      }}
      onAddCodeComment={vi.fn()}
    />
  )

  await waitFor(() => {
    expect(workspaceFileApi.readWorkspaceTextFile).toHaveBeenCalledWith(
      'device-1',
      'C:/Users/kunlunmeta/projects/gpt-model-service/src/registry.rs'
    )
  })
})

test('copies relative and absolute paths from the tree context menu and closes it', async () => {
  const workspaceFileApi = createWorkspaceFileApi()

  render(
    <FileWorkspacePanel
      target={{ deviceId: 'device-1', path: verbatimRoot, source: 'runtime' }}
      workspaceFileApi={workspaceFileApi as never}
      onAddCodeComment={vi.fn()}
    />
  )

  fireEvent.click(await screen.findByTestId('workspace-file-tree-context-trigger'))
  expect(await screen.findByTestId('workspace-file-context-menu')).toBeInTheDocument()

  fireEvent.click(screen.getByTestId('workspace-file-context-copy-relative'))
  expect(clipboardMock.copyTextToClipboard).toHaveBeenCalledWith('src/a.ts')
  expect(treeContextMenuMock.close).toHaveBeenCalledTimes(1)

  fireEvent.click(await screen.findByTestId('workspace-file-tree-context-trigger'))
  fireEvent.click(await screen.findByTestId('workspace-file-context-copy-absolute'))
  expect(clipboardMock.copyTextToClipboard).toHaveBeenCalledWith(
    'C:/Users/kunlunmeta/projects/gpt-model-service/src/a.ts'
  )
  expect(treeContextMenuMock.close).toHaveBeenCalledTimes(2)
})
