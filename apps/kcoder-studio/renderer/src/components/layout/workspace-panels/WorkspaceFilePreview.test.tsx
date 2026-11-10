import { act, fireEvent, render, screen } from '@testing-library/react'
import { useState } from 'react'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import '@/i18n'
import { WorkspaceFilePreview } from './WorkspaceFilePreview'
import { useWorkspaceFileNavigation } from '@/kcoder/useWorkspaceFileNavigation'
import { notifyAccountContextChange } from '@/kcoder/accountContextEvents'

const fileViewerMocks = vi.hoisted(() => ({
  render: vi.fn(),
  codeView: vi.fn(),
}))

vi.mock('@pierre/diffs/react', () => ({
  CodeView: (props: {
    items: { id: string; version: number; file: { contents: string } }[]
    onSelectedLinesChange: (selection: { id: string; range: { start: number; end: number } } | null) => void
  }) => {
    fileViewerMocks.codeView(props)
    return <div>
      <div data-testid="mock-code-content">{props.items[0].file.contents}</div>
      <button data-testid="mock-select-line" onClick={() => props.onSelectedLinesChange({ id: props.items[0].id, range: { start: 1, end: 1 } })}>Select line</button>
      <button data-testid="mock-clear-selection" onClick={() => props.onSelectedLinesChange(null)}>Clear selection</button>
    </div>
  },
}))

vi.mock('./WorkspaceDocumentViewer', () => ({
  WorkspaceDocumentViewer: (props: { filename: string }) => {
    fileViewerMocks.render(props)
    return <div data-testid="file-viewer">{props.filename}</div>
  },
}))

vi.mock('@file-viewer/preset-engineering', () => ({ default: {} }))
vi.mock('@file-viewer/preset-office', () => ({ default: {} }))
vi.mock('@file-viewer/preset-lite', () => ({ default: {} }))

beforeEach(() => {
  vi.stubGlobal('ResizeObserver', class {
    observe() {}
    disconnect() {}
  })
  fileViewerMocks.render.mockClear()
  fileViewerMocks.codeView.mockClear()
})

afterEach(() => vi.unstubAllGlobals())

const textFile = {
  path: '/workspace/report.md', name: 'report.md', content: 'old result',
  revision: 'native-v1', editable: true, truncated: false, size: 10,
}

test('controlled comments survive preview closure and stay with the original task and account', () => {
  const onOriginalComment = vi.fn()
  const onOtherComment = vi.fn()
  function Host({ deviceId }: { deviceId: string }) {
    const [open, setOpen] = useState(true)
    const { fileCommentController } = useWorkspaceFileNavigation('preview-comments', { deviceId, path: '/workspace', source: 'runtime' })
    return <>
      <button onClick={() => setOpen(value => !value)}>Toggle preview</button>
      {open && <WorkspaceFilePreview file={textFile} sourceRevision="artifact-v1" loading={false} onRetry={vi.fn()}
        commentController={fileCommentController} onAddCodeComment={deviceId === 'preview-owner' ? onOriginalComment : onOtherComment} />}
    </>
  }
  const view = render(<Host deviceId="preview-owner" />)
  fireEvent.click(screen.getByTestId('mock-select-line'))
  fireEvent.change(screen.getByTestId('workspace-file-comment-input'), { target: { value: 'Keep across closure' } })
  const oldSelection = fileViewerMocks.codeView.mock.lastCall![0].onSelectedLinesChange
  fireEvent.click(screen.getByText('Toggle preview'))
  expect(screen.queryByTestId('workspace-file-comment-input')).not.toBeInTheDocument()
  fireEvent.click(screen.getByText('Toggle preview'))
  expect(screen.getByTestId('workspace-file-comment-input')).toHaveValue('Keep across closure')
  view.rerender(<Host deviceId="preview-other" />)
  expect(screen.queryByTestId('workspace-file-comment-input')).not.toBeInTheDocument()
  act(() => oldSelection({ id: textFile.path, range: { start: 1, end: 1 } }))
  expect(screen.queryByTestId('workspace-file-comment-input')).not.toBeInTheDocument()
  expect(onOtherComment).not.toHaveBeenCalled()
  view.rerender(<Host deviceId="preview-owner" />)
  fireEvent.click(screen.getByTestId('workspace-file-add-comment-button'))
  expect(onOriginalComment).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({
    comment: 'Keep across closure', fileRevision: textFile.revision, sourceRevision: 'artifact-v1', selectedText: textFile.content,
  }))
  fireEvent.click(screen.getByTestId('mock-select-line'))
  fireEvent.change(screen.getByTestId('workspace-file-comment-input'), { target: { value: 'Private account draft' } })
  act(() => notifyAccountContextChange('preview-owner'))
  expect(screen.queryByTestId('workspace-file-comment-input')).not.toBeInTheDocument()
  expect(onOtherComment).not.toHaveBeenCalled()
})

test('keeps feedback bound to the original revision after a same-length file update', () => {
  const onAddCodeComment = vi.fn()
  const props = { file: textFile, loading: false, onRetry: vi.fn(), onAddCodeComment }
  const view = render(<WorkspaceFilePreview {...props} />)
  const previousVersion = fileViewerMocks.codeView.mock.lastCall![0].items[0].version
  fireEvent.click(screen.getByTestId('mock-select-line'))
  fireEvent.change(screen.getByTestId('workspace-file-comment-input'), { target: { value: 'Fix the original result' } })
  view.rerender(<WorkspaceFilePreview {...props} file={{ ...textFile, content: 'new result', revision: 'native-v2' }} />)
  expect(fileViewerMocks.codeView.mock.lastCall![0].items[0].version).not.toBe(previousVersion)
  expect(screen.getByTestId('workspace-file-comment-input')).toHaveValue('Fix the original result')
  expect(screen.getByTestId('workspace-file-comment-source-changed')).toBeInTheDocument()
  expect(screen.getByTestId('mock-code-content')).toHaveTextContent('new result')
  fireEvent.click(screen.getByTestId('workspace-file-add-comment-button'))
  expect(onAddCodeComment).toHaveBeenCalledWith(expect.objectContaining({
    filePath: '/workspace/report.md', fileRevision: 'native-v1', selectedText: 'old result',
    comment: 'Fix the original result',
  }))
})

test('keeps a feedback draft through loading, failed preview and visual deselection', () => {
  const onAddCodeComment = vi.fn()
  const props = { file: textFile, loading: false, onRetry: vi.fn(), onAddCodeComment }
  const view = render(<WorkspaceFilePreview {...props} />)
  fireEvent.click(screen.getByTestId('mock-select-line'))
  fireEvent.change(screen.getByTestId('workspace-file-comment-input'), { target: { value: 'Keep this feedback' } })
  fireEvent.click(screen.getByTestId('mock-clear-selection'))
  expect(screen.getByTestId('workspace-file-comment-input')).toHaveValue('Keep this feedback')
  view.rerender(<WorkspaceFilePreview {...props} file={null} loading />)
  expect(screen.getByTestId('workspace-file-comment-input')).toHaveValue('Keep this feedback')
  view.rerender(<WorkspaceFilePreview {...props} file={null} error="owned preview unavailable" />)
  expect(screen.getByText('owned preview unavailable')).toBeInTheDocument()
  expect(screen.getByTestId('workspace-file-comment-input')).toHaveValue('Keep this feedback')
  expect(onAddCodeComment).not.toHaveBeenCalled()
  fireEvent.click(screen.getByTestId('workspace-file-add-comment-button'))
  expect(onAddCodeComment.mock.calls[0][0]).toMatchObject({ fileRevision: 'native-v1', selectedText: 'old result' })
})

test('leaves a legacy preview version unknown instead of manufacturing a revision', () => {
  const onAddCodeComment = vi.fn()
  render(<WorkspaceFilePreview file={{ ...textFile, revision: '' }} loading={false} onRetry={vi.fn()} onAddCodeComment={onAddCodeComment} />)
  fireEvent.click(screen.getByTestId('mock-select-line'))
  expect(screen.getByText(/没有可确认的文件版本|no confirmed file version/)).toBeInTheDocument()
  fireEvent.change(screen.getByTestId('workspace-file-comment-input'), { target: { value: 'Review this preview' } })
  fireEvent.click(screen.getByTestId('workspace-file-add-comment-button'))
  expect(onAddCodeComment.mock.calls[0][0]).not.toHaveProperty('fileRevision')
})

test('does not rebuild a binary image preview when its parent rerenders', () => {
  const binaryFile = {
    path: '/workspace/project/diagram.png',
    name: 'diagram.png',
    size: 5,
    file: new File(['image'], 'diagram.png', { type: 'image/png' }),
  }
  const { rerender } = render(
    <WorkspaceFilePreview
      file={null}
      binaryFile={binaryFile}
      loading={false}
      onRetry={vi.fn()}
      onAddCodeComment={vi.fn()}
    />
  )

  rerender(
    <WorkspaceFilePreview
      file={null}
      binaryFile={binaryFile}
      loading={false}
      onRetry={vi.fn()}
      onAddCodeComment={vi.fn()}
    />
  )

  expect(fileViewerMocks.render).toHaveBeenCalledTimes(1)
})


test.each([
  ['native-v1', 'matches'],
  ['native-v2', 'changed'],
  ['', 'unknown'],
])('compares the referenced task version with the actual preview: %s', (revision, state) => {
  const onAddCodeComment = vi.fn()
  render(<WorkspaceFilePreview file={{ ...textFile, revision }} sourceRevision="native-v1" loading={false} onRetry={vi.fn()} onAddCodeComment={onAddCodeComment} />)
  expect(screen.getByTestId('workspace-file-source-version')).toHaveAttribute('data-version-state', state)
  fireEvent.click(screen.getByTestId('mock-select-line'))
  fireEvent.change(screen.getByTestId('workspace-file-comment-input'), { target: { value: 'Revise this preview' } })
  fireEvent.click(screen.getByTestId('workspace-file-add-comment-button'))
  expect(onAddCodeComment.mock.calls[0][0]).toMatchObject({ sourceRevision: 'native-v1' })
  if (revision) expect(onAddCodeComment.mock.calls[0][0].fileRevision).toBe(revision)
})


test('a truncated preview cannot establish a full artifact version mismatch', () => {
  render(<WorkspaceFilePreview file={{ ...textFile, truncated: true }} sourceRevision="full-file-sha" loading={false} onRetry={vi.fn()} onAddCodeComment={vi.fn()} />)
  expect(screen.getByTestId('workspace-file-source-version')).toHaveAttribute('data-version-state', 'unknown')
})
