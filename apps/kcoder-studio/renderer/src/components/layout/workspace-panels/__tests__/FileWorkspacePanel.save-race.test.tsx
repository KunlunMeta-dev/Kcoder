import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { expect, test, vi } from 'vitest'
import '@/i18n'
import { FileWorkspacePanel } from '../FileWorkspacePanel'

vi.mock('@/lib/local-terminal', () => ({
  isLocalTerminalAvailable: () => false,
  listLocalFileOpeners: async () => ({ applications: [], default_path: null }),
}))
vi.mock('../WorkspaceFileTree', () => ({ WorkspaceFileTree: () => null }))
vi.mock('../WorkspaceFilePreview', () => ({
  WorkspaceFilePreview: (props: {
    file: { content: string } | null
    editing: boolean
    editedContent: string
    onEditedContentChange: (value: string) => void
  }) =>
    props.editing ? (
      <textarea
        data-testid="race-editor"
        value={props.editedContent}
        onChange={event => props.onEditedContentChange(event.target.value)}
      />
    ) : (
      <div data-testid="race-preview">{props.file?.content}</div>
    ),
}))

function fixture() {
  let finish!: (value: unknown) => void
  const write = vi.fn(
    () =>
      new Promise(resolve => {
        finish = resolve
      })
  )
  const content = (name: string, text = `${name} original`, revision = 'old') => ({
    path: `/workspace/${name}`,
    name,
    content: text,
    editable: true,
    revision,
    truncated: false,
    size: text.length,
  })
  const api = {
    listWorkspaceEntries: vi.fn(async () => ({ path: '/workspace', entries: [] })),
    readWorkspaceTextFile: vi.fn(async (_device, path: string) => content(path.split('/').pop()!)),
    writeWorkspaceTextFile: write,
  }
  const props = {
    target: { deviceId: 'device', path: '/workspace', source: 'runtime' as const },
    workspaceFileApi: api as never,
    onAddCodeComment: vi.fn(),
  }
  return { props, write, content, finish: (value: unknown) => finish(value) }
}

test('saving an earlier draft retains text entered during the pending disk write', async () => {
  const host = fixture()
  render(<FileWorkspacePanel {...host.props} openFileRequest={{ id: 1, path: 'a.ts' }} />)
  await screen.findByText('a.ts original')
  fireEvent.click(screen.getByTestId('workspace-file-edit-button'))
  fireEvent.change(screen.getByTestId('race-editor'), { target: { value: 'submitted draft' } })
  fireEvent.click(screen.getByTestId('workspace-file-save-button'))
  fireEvent.change(screen.getByTestId('race-editor'), { target: { value: 'newer unsaved draft' } })
  await act(async () => host.finish(host.content('a.ts', 'submitted draft', 'saved')))
  expect(screen.getByTestId('race-editor')).toHaveValue('newer unsaved draft')
  expect(screen.getByTestId('workspace-file-save-button')).toBeEnabled()
  expect(host.write).toHaveBeenCalledWith('device', '/workspace/a.ts', 'submitted draft', 'old')
})

test('discard-navigation during a pending save cannot replace the next file preview', async () => {
  const host = fixture()
  const view = render(
    <FileWorkspacePanel {...host.props} openFileRequest={{ id: 1, path: 'a.ts' }} />
  )
  await screen.findByText('a.ts original')
  fireEvent.click(screen.getByTestId('workspace-file-edit-button'))
  fireEvent.change(screen.getByTestId('race-editor'), { target: { value: 'saved A' } })
  fireEvent.click(screen.getByTestId('workspace-file-save-button'))
  view.rerender(<FileWorkspacePanel {...host.props} openFileRequest={{ id: 2, path: 'b.ts' }} />)
  await screen.findByTestId('workspace-file-unsaved-discard')
  fireEvent.click(screen.getByTestId('workspace-file-unsaved-discard'))
  await screen.findByText('b.ts original')
  await act(async () => host.finish(host.content('a.ts', 'saved A', 'saved')))
  await waitFor(() => expect(screen.getByTestId('race-preview')).toHaveTextContent('b.ts original'))
  fireEvent.click(screen.getByTestId('workspace-file-edit-button'))
  expect(screen.getByTestId('race-editor')).toHaveValue('b.ts original')
})

test.each([false, true])(
  'model-independent: late path-kind lookup preserves later selection; edited=%s',
  async edited => {
    let finish!: (value: unknown) => void
    const list = vi
      .fn()
      .mockResolvedValueOnce({ path: '/workspace', entries: [] })
      .mockImplementationOnce(
        () =>
          new Promise(resolve => {
            finish = resolve
          })
      )
      .mockResolvedValue({ path: '/workspace', entries: [] })
    const props = {
      target: { deviceId: 'device', path: '/workspace', source: 'runtime' as const },
      workspaceFileApi: {
        listWorkspaceEntries: list,
        readWorkspaceTextFile: vi.fn(async (_device, path: string) => ({
          path,
          name: path.split('/').pop(),
          content: path + ' original',
          editable: true,
          revision: 'old',
          truncated: false,
          size: 10,
        })),
        writeWorkspaceTextFile: vi.fn(),
      } as never,
      onAddCodeComment: vi.fn(),
    }
    const view = render(<FileWorkspacePanel {...props} openFileRequest={{ id: 1, path: 'a.ts' }} />)
    await waitFor(() => expect(list).toHaveBeenCalledTimes(2))
    view.rerender(<FileWorkspacePanel {...props} openFileRequest={{ id: 2, path: 'b.ts' }} />)
    await screen.findByText('/workspace/b.ts original')
    if (edited) {
      fireEvent.click(screen.getByTestId('workspace-file-edit-button'))
      fireEvent.change(screen.getByTestId('race-editor'), {
        target: { value: 'new unsaved B draft' },
      })
    }
    await act(async () => finish({ path: '/workspace', entries: [] }))
    expect(screen.getByTestId('workspace-file-path')).toHaveTextContent('/workspace/b.ts')
    if (edited) expect(screen.getByTestId('race-editor')).toHaveValue('new unsaved B draft')
  }
)

test('model-independent: the first keystroke does not replay the existing open request as a navigation', async () => {
  render(
    <FileWorkspacePanel
      target={{ deviceId: 'device', path: '/workspace', source: 'runtime' }}
      workspaceFileApi={
        {
          listWorkspaceEntries: vi.fn(async () => ({ path: '/workspace', entries: [] })),
          readWorkspaceTextFile: vi.fn(async () => ({
            path: '/workspace/a.ts',
            name: 'a.ts',
            content: 'original',
            editable: true,
            revision: 'old',
            truncated: false,
            size: 8,
          })),
          writeWorkspaceTextFile: vi.fn(),
        } as never
      }
      onAddCodeComment={vi.fn()}
      openFileRequest={{ id: 1, path: 'a.ts' }}
    />
  )
  await screen.findByText('original')
  fireEvent.click(screen.getByTestId('workspace-file-edit-button'))
  fireEvent.change(screen.getByTestId('race-editor'), { target: { value: 'first edited draft' } })
  await act(async () => {
    await Promise.resolve()
  })
  expect(screen.queryByTestId('workspace-file-unsaved-dialog')).not.toBeInTheDocument()
})

test.each(['file', 'directory', 'failure'] as const)(
  'late %s type lookup cannot replace a newer edited file',
  async kind => {
    const host = fixture()
    let finish!: (value: unknown) => void
    let fail!: (error: Error) => void
    host.props.workspaceFileApi = {
      ...(host.props.workspaceFileApi as object),
      listWorkspaceEntries: vi
        .fn()
        .mockResolvedValueOnce({ path: '/workspace', entries: [] })
        .mockImplementationOnce(
          () =>
            new Promise((resolve, reject) => {
              finish = resolve
              fail = reject
            })
        )
        .mockResolvedValue({ path: '/workspace', entries: [] }),
    } as never
    const view = render(
      <FileWorkspacePanel {...host.props} openFileRequest={{ id: 1, path: 'a.ts' }} />
    )
    await act(async () => {
      await Promise.resolve()
    })
    view.rerender(<FileWorkspacePanel {...host.props} openFileRequest={{ id: 2, path: 'b.ts' }} />)
    await screen.findByText('b.ts original')
    fireEvent.click(screen.getByTestId('workspace-file-edit-button'))
    fireEvent.change(screen.getByTestId('race-editor'), { target: { value: 'B draft' } })
    await act(async () =>
      kind === 'failure'
        ? fail(new Error('lookup failed'))
        : finish({
            path: '/workspace',
            entries:
              kind === 'directory'
                ? [{ path: '/workspace/a.ts', name: 'a.ts', isDirectory: true }]
                : [],
          })
    )
    expect(screen.getByTestId('workspace-file-path')).toHaveTextContent('/workspace/b.ts')
    expect(screen.getByTestId('race-editor')).toHaveValue('B draft')
  }
)

test.each(['target', 'unmount'] as const)(
  'a pending type lookup is cancelled on %s',
  async boundary => {
    const host = fixture()
    let finish!: (value: unknown) => void
    const read = vi.fn(async (_device, path: string) => host.content(path.split('/').pop()!))
    const list = vi
      .fn()
      .mockResolvedValueOnce({ path: '/workspace', entries: [] })
      .mockImplementationOnce(
        () =>
          new Promise(resolve => {
            finish = resolve
          })
      )
      .mockResolvedValue({ path: '/other', entries: [] })
    host.props.workspaceFileApi = {
      listWorkspaceEntries: list,
      readWorkspaceTextFile: read,
      writeWorkspaceTextFile: host.write,
    } as never
    const view = render(
      <FileWorkspacePanel {...host.props} openFileRequest={{ id: 1, path: 'a.ts' }} />
    )
    await waitFor(() => expect(list).toHaveBeenCalledTimes(2))
    if (boundary === 'target')
      view.rerender(
        <FileWorkspacePanel
          {...host.props}
          target={{ deviceId: 'other-device', path: '/other', source: 'runtime' }}
        />
      )
    else view.unmount()
    await act(async () => finish({ path: '/workspace', entries: [] }))
    expect(read).not.toHaveBeenCalled()
  }
)

test('new request IDs retain cancel and save guards without replaying cancelled navigation', async () => {
  const host = fixture()
  const view = render(
    <FileWorkspacePanel {...host.props} openFileRequest={{ id: 1, path: 'a.ts' }} />
  )
  await screen.findByText('a.ts original')
  fireEvent.click(screen.getByTestId('workspace-file-edit-button'))
  fireEvent.change(screen.getByTestId('race-editor'), { target: { value: 'A draft' } })
  view.rerender(<FileWorkspacePanel {...host.props} openFileRequest={{ id: 2, path: 'b.ts' }} />)
  fireEvent.click(await screen.findByTestId('workspace-file-unsaved-cancel'))
  fireEvent.change(screen.getByTestId('race-editor'), { target: { value: 'A final draft' } })
  await act(async () => {
    await Promise.resolve()
  })
  expect(screen.queryByTestId('workspace-file-unsaved-dialog')).not.toBeInTheDocument()
  view.rerender(<FileWorkspacePanel {...host.props} openFileRequest={{ id: 3, path: 'b.ts' }} />)
  fireEvent.click(await screen.findByTestId('workspace-file-unsaved-save'))
  await act(async () => host.finish(host.content('a.ts', 'A final draft', 'saved')))
  await screen.findByText('b.ts original')
  expect(host.write).toHaveBeenCalledWith('device', '/workspace/a.ts', 'A final draft', 'old')
})

test('cancelling navigation during its pending save keeps the edited file selected', async () => {
  const host = fixture()
  const view = render(
    <FileWorkspacePanel {...host.props} openFileRequest={{ id: 1, path: 'a.ts' }} />
  )
  await screen.findByText('a.ts original')
  fireEvent.click(screen.getByTestId('workspace-file-edit-button'))
  fireEvent.change(screen.getByTestId('race-editor'), { target: { value: 'saved A draft' } })
  view.rerender(<FileWorkspacePanel {...host.props} openFileRequest={{ id: 2, path: 'b.ts' }} />)
  fireEvent.click(await screen.findByTestId('workspace-file-unsaved-save'))
  fireEvent.click(screen.getByTestId('workspace-file-unsaved-cancel'))
  await act(async () => host.finish(host.content('a.ts', 'saved A draft', 'saved')))
  expect(screen.getByTestId('workspace-file-path')).toHaveTextContent('/workspace/a.ts')
  expect(screen.getByTestId('race-preview')).toHaveTextContent('saved A draft')
})
