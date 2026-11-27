import { useMemo, useState } from 'react'
import { act, fireEvent, render, screen } from '@testing-library/react'
import { expect, test, vi } from 'vitest'
import '@/i18n'
import { RightWorkspacePanel, type RightWorkspacePanelTab } from '../RightWorkspacePanel'
import { useWorkspaceFileNavigation } from '@/kcoder/useWorkspaceFileNavigation'
import type { WorkspaceFileApi } from '@/types/workspace-files'

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
        data-testid="dirty-editor"
        value={props.editedContent}
        onChange={event => props.onEditedContentChange(event.target.value)}
      />
    ) : (
      <p data-testid="dirty-preview">{props.file?.content}</p>
    ),
}))
vi.mock('../TemporaryChatPanel', () => ({ TemporaryChatPanel: () => null }))
vi.mock('../WorkspacePanelCards', () => ({ WorkspacePanelCards: () => null }))
vi.mock('../WorkspaceBrowserPanel', () => ({ WorkspaceBrowserPanel: () => null }))
vi.mock('@/components/chat/FileChangesReviewPanel', () => ({
  FileChangesReviewPanel: () => <p>Review view</p>,
}))

const read = (device: string, content = `${device} original`, revision = 'read-v1') => ({
  path: '/workspace/a.ts',
  name: 'a.ts',
  content,
  revision,
  editable: true,
  truncated: false,
  size: content.length,
})
function fixture() {
  const api = {
    listWorkspaceEntries: vi.fn(async () => ({ path: '/workspace', entries: [] })),
    readWorkspaceTextFile: vi.fn(async device => read(device)),
    writeWorkspaceTextFile: vi.fn(async (device, _path, text) => read(device, text, 'saved-v2')),
  }
  return { api, closed: vi.fn(), cancelProposal: vi.fn() }
}
function Host({
  api,
  closed,
  cancelProposal,
  owner = 'A',
  standalone = false,
}: ReturnType<typeof fixture> & { owner?: string; standalone?: boolean }) {
  const target = useMemo(
    () => ({ deviceId: `device-${owner}`, path: '/workspace', source: 'runtime' as const }),
    [owner]
  )
  const navigation = useWorkspaceFileNavigation(owner, target)
  const [visible, setVisible] = useState(true)
  const [tabs, setTabs] = useState<RightWorkspacePanelTab[]>(['files', 'review'])
  const [active, setActive] = useState<RightWorkspacePanelTab>('files')
  const request = { id: 1, path: 'a.ts', isDirectory: false }
  return (
    <>
      <button
        data-testid="hide-files-pane"
        onClick={() => navigation.fileEditorNavigation.request(() => setVisible(false))}
      >
        Hide right pane
      </button>
      <span data-testid="editor-pin-state">{String(navigation.fileEditorNavigation.dirty)}</span>
      {visible && tabs.includes('files') ? (
        <RightWorkspacePanel
          visible
          activeView={active}
          openTabs={tabs}
          currentProject={null}
          currentRuntimeTask={{
            deviceId: target.deviceId,
            taskId: `task-${owner}`,
            threadId: `thread-${owner}`,
          }}
          devices={[]}
          workspaceTarget={target}
          canBrowseFiles
          canOpenBrowser={false}
          workspaceFileApi={api as WorkspaceFileApi}
          openFileRequest={request}
          fileNavigationScope={navigation.fileNavigationScope}
          {...(standalone ? {} : { fileEditorNavigation: navigation.fileEditorNavigation })}
          onCancelFileOpenRequest={cancelProposal}
          review={{ loading: false, diff: '' }}
          canOpenReview
          onAddCodeComment={vi.fn()}
          onSelectReview={() => setActive('review')}
          onSelectTerminal={vi.fn()}
          onSelectBrowser={vi.fn()}
          onSelectFiles={() => setActive('files')}
          onSelectChat={vi.fn()}
          onSelectPlan={vi.fn()}
          onSelectTab={tab =>
            standalone
              ? setActive(tab)
              : navigation.fileEditorNavigation.request(() => setActive(tab))
          }
          onCloseTab={tab => {
            const close = () => {
              closed(owner)
              setTabs(values => values.filter(value => value !== tab))
            }
            if (standalone) close()
            else navigation.fileEditorNavigation.request(close)
          }}
        />
      ) : (
        <p data-testid="files-closed">Files closed</p>
      )}
    </>
  )
}
async function edit(text = 'unsaved draft') {
  await screen.findByText('device-A original')
  fireEvent.click(screen.getByTestId('workspace-file-edit-button'))
  fireEvent.change(screen.getByTestId('dirty-editor'), { target: { value: text } })
}
function closeTab() {
  fireEvent.click(screen.getByTestId('right-workspace-file-tab-close-button'))
}

test.each([false, true])(
  'closing Files consults the existing dialog; cancel keeps draft and discard closes only that pane (standalone=%s)',
  async standalone => {
    const host = fixture()
    render(<Host {...host} standalone={standalone} />)
    await edit()
    closeTab()
    await screen.findByTestId('workspace-file-unsaved-dialog')
    expect(host.closed).not.toHaveBeenCalled()
    fireEvent.click(screen.getByTestId('workspace-file-unsaved-cancel'))
    expect(screen.getByTestId('dirty-editor')).toHaveValue('unsaved draft')
    expect(host.cancelProposal).not.toHaveBeenCalled()
    expect(host.api.writeWorkspaceTextFile).not.toHaveBeenCalled()
    closeTab()
    fireEvent.click(await screen.findByTestId('workspace-file-unsaved-discard'))
    expect(host.closed).toHaveBeenCalledExactlyOnceWith('A')
    expect(screen.getByTestId('files-closed')).toBeInTheDocument()
  }
)

test('hiding the right pane or selecting a different tab preserves dirty text until explicitly resolved', async () => {
  const host = fixture()
  render(<Host {...host} />)
  await edit()
  expect(screen.getByTestId('editor-pin-state')).toHaveTextContent('true')
  fireEvent.click(screen.getByTestId('hide-files-pane'))
  fireEvent.click(await screen.findByTestId('workspace-file-unsaved-cancel'))
  expect(screen.getByTestId('dirty-editor')).toHaveValue('unsaved draft')
  fireEvent.click(screen.getByTestId('right-workspace-review-tab'))
  fireEvent.click(await screen.findByTestId('workspace-file-unsaved-cancel'))
  expect(screen.queryByText('Review view')).not.toBeInTheDocument()
  fireEvent.click(screen.getByTestId('hide-files-pane'))
  fireEvent.click(await screen.findByTestId('workspace-file-unsaved-save'))
  await screen.findByTestId('files-closed')
  expect(host.api.writeWorkspaceTextFile).toHaveBeenCalledWith(
    'device-A',
    '/workspace/a.ts',
    'unsaved draft',
    'read-v1'
  )
  expect(screen.getByTestId('editor-pin-state')).toHaveTextContent('false')
})

test('another process changing the disk keeps the editor and pending close after a failed CAS save', async () => {
  const host = fixture()
  host.api.writeWorkspaceTextFile.mockRejectedValue(new Error('file changed on disk'))
  render(<Host {...host} />)
  await edit()
  closeTab()
  fireEvent.click(await screen.findByTestId('workspace-file-unsaved-save'))
  await screen.findByText('file changed on disk')
  expect(screen.getByTestId('workspace-file-unsaved-dialog')).toBeInTheDocument()
  expect(screen.getByTestId('dirty-editor')).toHaveValue('unsaved draft')
  expect(host.closed).not.toHaveBeenCalled()
  expect(screen.getByTestId('editor-pin-state')).toHaveTextContent('true')
})

test('a save requested by old owner A cannot close newer owner B after its response arrives', async () => {
  const host = fixture()
  let finish!: (value: ReturnType<typeof read>) => void
  host.api.writeWorkspaceTextFile.mockImplementation(
    () =>
      new Promise(resolve => {
        finish = resolve
      })
  )
  const view = render(<Host {...host} />)
  await edit('A submitted')
  closeTab()
  fireEvent.click(await screen.findByTestId('workspace-file-unsaved-save'))
  view.rerender(<Host {...host} owner="B" />)
  await screen.findByText('device-B original')
  fireEvent.click(screen.getByTestId('workspace-file-edit-button'))
  fireEvent.change(screen.getByTestId('dirty-editor'), { target: { value: 'B draft retained' } })
  await act(async () => finish(read('device-A', 'A submitted', 'saved-A')))
  expect(screen.getByTestId('dirty-editor')).toHaveValue('B draft retained')
  expect(host.closed).not.toHaveBeenCalled()
  expect(screen.getByTestId('editor-pin-state')).toHaveTextContent('true')
})

test('save then close settles only the submitted revision and retains newer edits before a second save', async () => {
  const host = fixture()
  let finish!: (value: ReturnType<typeof read>) => void
  host.api.writeWorkspaceTextFile.mockImplementationOnce(
    () =>
      new Promise(resolve => {
        finish = resolve
      })
  )
  render(<Host {...host} />)
  await edit('submitted')
  closeTab()
  fireEvent.click(await screen.findByTestId('workspace-file-unsaved-save'))
  fireEvent.change(screen.getByTestId('dirty-editor'), { target: { value: 'newer unsaved text' } })
  await act(async () => finish(read('device-A', 'submitted', 'saved-v2')))
  expect(screen.getByTestId('dirty-editor')).toHaveValue('newer unsaved text')
  expect(host.closed).not.toHaveBeenCalled()
  fireEvent.click(screen.getByTestId('workspace-file-unsaved-save'))
  await screen.findByTestId('files-closed')
  expect(host.api.writeWorkspaceTextFile).toHaveBeenLastCalledWith(
    'device-A',
    '/workspace/a.ts',
    'newer unsaved text',
    'saved-v2'
  )
})
