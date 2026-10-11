import { act, render, screen, waitFor } from '@testing-library/react'
import { expect, test, vi } from 'vitest'
import '@/i18n'
import { FileWorkspacePanel } from '../FileWorkspacePanel'
import type { WorkspaceFileChunkResponse } from '@/types/workspace-files'

const observed = vi.hoisted(() => ({ progress: [] as number[], previewSizes: [] as number[] }))
vi.mock('@/lib/local-terminal', () => ({ isLocalTerminalAvailable: () => false }))
vi.mock('../WorkspaceFileTree', () => ({ WorkspaceFileTree: () => null }))
vi.mock('../WorkspaceFilePreview', () => ({
  WorkspaceFilePreview: (props: {
    binaryFile: { file: File } | null
    loadingProgress: { loadedBytes: number; totalBytes: number | null } | null
  }) => {
    if (props.loadingProgress?.totalBytes)
      observed.progress.push(
        Math.round((props.loadingProgress.loadedBytes / props.loadingProgress.totalBytes) * 100)
      )
    if (props.binaryFile) observed.previewSizes.push(props.binaryFile.file.size)
    return props.binaryFile ? (
      <span data-testid="binary-size">{props.binaryFile.file.size}</span>
    ) : null
  },
}))

function pendingReads() {
  const replies: ((chunk: WorkspaceFileChunkResponse) => void)[] = []
  const read = vi.fn(
    () => new Promise<WorkspaceFileChunkResponse>(resolve => replies.push(resolve))
  )
  const api = {
    listWorkspaceEntries: vi.fn(async () => ({ path: '/workspace', entries: [] })),
    readWorkspaceTextFile: vi.fn(),
    readWorkspaceFileChunk: read,
  }
  const props = {
    target: { deviceId: 'device', path: '/workspace', source: 'runtime' as const },
    workspaceFileApi: api,
    onAddCodeComment: vi.fn(),
    openFileRequest: { id: 1, path: 'preview.pdf' },
  }
  return { read, replies, props, view: render(<FileWorkspacePanel {...props} />) }
}

function chunk(offset: number, size: number, contentBase64: string): WorkspaceFileChunkResponse {
  return {
    path: '/workspace/preview.pdf',
    name: 'preview.pdf',
    modifiedAt: '1000',
    revision: 'owned-revision',
    offset,
    size,
    contentBase64,
    eof: offset + atob(contentBase64).length === size,
  }
}

test('200 valid chunks render only changes to the visible integer percentage', async () => {
  observed.progress = []
  const host = pendingReads()
  // 3.125 MiB is within the existing preview ability; each response is below
  // the 1 MiB chunk maximum. No fictional total or file-size quota is involved.
  const chunkBytes = 16 * 1024
  const totalBytes = 200 * chunkBytes
  const encoded = btoa('x'.repeat(chunkBytes))
  await waitFor(() => expect(host.read).toHaveBeenCalledTimes(1))
  for (let index = 0; index < 200; index++) {
    await act(async () => host.replies[index](chunk(index * chunkBytes, totalBytes, encoded)))
  }
  expect(await screen.findByTestId('binary-size')).toHaveTextContent(String(totalBytes))
  expect(host.read).toHaveBeenCalledTimes(200)
  expect(observed.progress).toHaveLength(100)
  expect(new Set(observed.progress).size).toBe(observed.progress.length)
  expect(observed.progress.at(-1)).toBe(100)
})

test.each(['unmount', 'new selection', 'target change', 'completed preview'])(
  'releases accumulated chunk storage immediately on %s while the next RPC is pending',
  async cancellation => {
    const host = pendingReads()
    await waitFor(() => expect(host.read).toHaveBeenCalledTimes(1))
    const chunkBytes = 1024 * 1024
    const encoded = btoa('\x1f'.repeat(chunkBytes))
    // Observe the real accumulator, not GC timing or a mock resource. Keep the
    // exact same array alive so clearing only a ref cannot satisfy this test.
    let accumulated: unknown[] | undefined
    const originalPush = Array.prototype.push
    Array.prototype.push = function (this: unknown[], ...values: unknown[]) {
      if (values[0] instanceof Uint8Array && values[0].length === chunkBytes && values[0][0] === 31)
        // eslint-disable-next-line @typescript-eslint/no-this-alias -- The original container proves release before the pending RPC settles.
        accumulated = this
      return originalPush.apply(this, values)
    }
    try {
      await act(async () => host.replies[0](chunk(0, 2 * chunkBytes, encoded)))
    } finally {
      Array.prototype.push = originalPush
    }
    await waitFor(() => expect(host.read).toHaveBeenCalledTimes(2))
    expect(accumulated).toHaveLength(1)
    expect((accumulated?.[0] as Uint8Array).byteLength).toBe(chunkBytes)
    if (cancellation === 'completed preview') {
      await act(async () => host.replies[1](chunk(chunkBytes, 2 * chunkBytes, encoded)))
      expect(await screen.findByTestId('binary-size')).toHaveTextContent(String(2 * chunkBytes))
      expect(accumulated).toHaveLength(0)
      return
    }
    if (cancellation === 'unmount') host.view.unmount()
    else {
      host.view.rerender(
        <FileWorkspacePanel
          {...host.props}
          target={
            cancellation === 'target change'
              ? { ...host.props.target, deviceId: 'next' }
              : host.props.target
          }
          openFileRequest={{ id: 2, path: 'next.pdf' }}
        />
      )
      await waitFor(() => expect(host.read).toHaveBeenCalledTimes(3))
    }
    expect(accumulated).toHaveLength(0)
    // A late old reply cannot refill released storage or publish the old File.
    observed.previewSizes = []
    await act(async () => host.replies[1](chunk(chunkBytes, 2 * chunkBytes, encoded)))
    expect(accumulated).toHaveLength(0)
    expect(observed.previewSizes).toEqual([])
    if (cancellation !== 'unmount') {
      await act(async () =>
        host.replies[2]({
          ...chunk(0, 2, btoa('\x23\x24')),
          path: '/workspace/next.pdf',
          name: 'next.pdf',
        })
      )
      expect(await screen.findByTestId('binary-size')).toHaveTextContent('2')
    }
  }
)
