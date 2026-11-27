import { render, screen } from '@testing-library/react'
import { describe, expect, test, vi } from 'vitest'
import '@/i18n'
import { WorkspaceFileTree } from './WorkspaceFileTree'
import type { WorkspaceFileEntry } from '@/types/workspace-files'

type ContextMenuOnOpen = (
  item: { kind: 'directory' | 'file'; name: string; path: string },
  context: {
    anchorRect?: { left: number; top: number }
    close: (options?: { restoreFocus?: boolean }) => void
  }
) => void

// Pierre renders rows and the context-menu slot inside a Preact shadow root that jsdom does not
// populate, so the composition callback is captured here instead of right-clicking a rendered row.
const pierreTreesMock = vi.hoisted(() => ({
  contextMenuOnOpen: null as ContextMenuOnOpen | null,
}))

vi.mock('@pierre/trees/react', () => ({
  FileTree: (props: { 'data-testid'?: string }) => <div data-testid={props['data-testid']} />,
  useFileTree: (options: { composition?: { contextMenu?: { onOpen?: ContextMenuOnOpen } } }) => {
    pierreTreesMock.contextMenuOnOpen = options.composition?.contextMenu?.onOpen ?? null

    return {
      model: {
        getItem: () => null,
        setSearch: () => {},
      },
    }
  },
}))

function createFileEntry(index: number): WorkspaceFileEntry {
  return {
    name: `file-${index.toString().padStart(4, '0')}.ts`,
    path: `/workspace/project/file-${index.toString().padStart(4, '0')}.ts`,
    isDirectory: false,
    size: index,
    modifiedAt: '2026-06-15T00:00:00.000Z',
  }
}

function renderTree(
  entriesByPath: Record<string, WorkspaceFileEntry[]>,
  onEntryContextMenu?: (
    entry: WorkspaceFileEntry,
    position: { left: number; top: number },
    close: () => void
  ) => void
) {
  return render(
    <WorkspaceFileTree
      rootPath="/workspace/project"
      activeDirectoryPath="/workspace/project"
      entriesByPath={entriesByPath}
      expandedPaths={new Set()}
      selectedPath={null}
      loadingPaths={new Set()}
      error={null}
      onOpenDirectory={vi.fn()}
      onOpenFile={vi.fn()}
      onRefresh={vi.fn()}
      onEntryContextMenu={onEntryContextMenu}
    />
  )
}

describe('WorkspaceFileTree', () => {
  test('uses Pierre tree for large directory listings', async () => {
    const entries = Array.from({ length: 1000 }, (_, index) => createFileEntry(index))

    renderTree({ '/workspace/project': entries })

    expect(await screen.findByTestId('workspace-file-tree-pierre')).toBeInTheDocument()
  })

  test('deduplicates conflicting directory paths before creating the Pierre tree', async () => {
    const directory: WorkspaceFileEntry = {
      name: 'tmp',
      path: '/workspace/project/tmp',
      isDirectory: true,
      size: 0,
      modifiedAt: '2026-06-15T00:00:00.000Z',
    }
    const staleFile: WorkspaceFileEntry = {
      ...directory,
      isDirectory: false,
      size: 12,
    }

    renderTree({ '/workspace/project': [directory, staleFile] })

    expect(await screen.findByTestId('workspace-file-tree-pierre')).toBeInTheDocument()
  })

  test('right-click on a tree row forwards the entry, position and close handler', async () => {
    const fileEntry = createFileEntry(1)
    const onEntryContextMenu = vi.fn()

    renderTree({ '/workspace/project': [fileEntry] }, onEntryContextMenu)

    await screen.findByTestId('workspace-file-tree-pierre')
    const close = vi.fn()
    expect(pierreTreesMock.contextMenuOnOpen).toBeTypeOf('function')

    pierreTreesMock.contextMenuOnOpen?.(
      { kind: 'file', name: fileEntry.name, path: fileEntry.name },
      { anchorRect: { left: 12, top: 34 }, close }
    )

    expect(onEntryContextMenu).toHaveBeenCalledWith(
      expect.objectContaining({ path: fileEntry.path }),
      { left: 12, top: 34 },
      expect.any(Function)
    )

    const forwardClose = onEntryContextMenu.mock.calls[0][2] as () => void
    forwardClose()
    expect(close).toHaveBeenCalledTimes(1)
  })

  test('right-click without a matching entry closes the Pierre menu', async () => {
    const onEntryContextMenu = vi.fn()

    renderTree({ '/workspace/project': [createFileEntry(1)] }, onEntryContextMenu)

    await screen.findByTestId('workspace-file-tree-pierre')
    const close = vi.fn()

    pierreTreesMock.contextMenuOnOpen?.(
      { kind: 'file', name: 'missing.ts', path: 'missing.ts' },
      { anchorRect: { left: 0, top: 0 }, close }
    )

    expect(onEntryContextMenu).not.toHaveBeenCalled()
    expect(close).toHaveBeenCalledTimes(1)
  })
})
