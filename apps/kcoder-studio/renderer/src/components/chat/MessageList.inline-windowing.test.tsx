import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, test, vi } from 'vitest'
import type { ProcessingBlock } from '@/types/workbench'
import { MessageList } from './MessageList'
import { firstTextNode, selectText, setDocumentSelection } from './MessageList.test-support'
import { clearPersistentProcessingExpansions } from './blocks/processingExpansionState'
import '@/i18n'

const tauriCoreMock = vi.hoisted(() => ({
  convertFileSrc: vi.fn((path: string) => `asset://localhost/${path.replace(/^\/+/, '')}`),
  invoke: vi.fn(),
  isTauri: vi.fn(() => false),
}))
const openExternalUrlMock = vi.hoisted(() => vi.fn().mockResolvedValue(true))
const requestEmbeddedBrowserOpenMock = vi.hoisted(() => vi.fn(() => true))

vi.mock('@tauri-apps/api/core', () => tauriCoreMock)
vi.mock('@/lib/external-links', async importOriginal => ({
  ...(await importOriginal<typeof import('@/lib/external-links')>()),
  openExternalUrl: openExternalUrlMock,
}))
vi.mock('@/lib/embedded-browser', () => ({
  requestEmbeddedBrowserOpen: requestEmbeddedBrowserOpenMock,
}))

describe('MessageList', () => {
  const originalCreateObjectUrl = URL.createObjectURL
  const originalRevokeObjectUrl = URL.revokeObjectURL

  afterEach(() => {
    vi.useRealTimers()
    clearPersistentProcessingExpansions()
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
    tauriCoreMock.convertFileSrc
      .mockReset()
      .mockImplementation((path: string) => `asset://localhost/${path.replace(/^\/+/, '')}`)
    tauriCoreMock.invoke.mockReset()
    tauriCoreMock.isTauri.mockReset().mockReturnValue(false)
    openExternalUrlMock.mockClear()
    requestEmbeddedBrowserOpenMock.mockClear()
    localStorage.clear()
    URL.createObjectURL = originalCreateObjectUrl
    URL.revokeObjectURL = originalRevokeObjectUrl
    delete (window as typeof window & { __KCODER_GATEWAY_WEB_SHIM__?: boolean })
      .__KCODER_GATEWAY_WEB_SHIM__
    delete (navigator as unknown as { clipboard?: Clipboard }).clipboard
  })
  test('renders a generated Codex inline visualization from the changed workspace file', () => {
    render(
      <MessageList
        messages={[
          {
            id: 'assistant-inline-visualization',
            role: 'assistant',
            content: [
              '已生成折线图。',
              '',
              '::codex-inline-vis{file="weekly-values-line-chart.html"}',
            ].join('\n'),
            status: 'done',
            createdAt: '2026-07-23T10:00:00Z',
            fileChanges: {
              version: 1,
              status: 'active',
              artifact_id: 'artifact-inline-visualization',
              device_id: 'device-1',
              workspace_path: '/Users/dev/workspace',
              file_count: 1,
              additions: 1,
              deletions: 0,
              files: [
                {
                  path: '.codex/visualizations/2026/07/23/thread-1/weekly-values-line-chart.html',
                  change_type: 'created',
                  additions: 1,
                  deletions: 0,
                  binary: false,
                },
              ],
            },
          },
        ]}
      />
    )

    expect(screen.getByText('已生成折线图。')).toBeInTheDocument()
    expect(screen.queryByText('::codex-inline-vis')).not.toBeInTheDocument()
    expect(screen.getByTestId('codex-inline-visualization-frame')).toHaveAttribute(
      'src',
      'asset://localhost/Users/dev/workspace/.codex/visualizations/2026/07/23/thread-1/weekly-values-line-chart.html'
    )
  })

  test('offers conversation actions for text selected inside one message body', async () => {
    const onAddSelectionToConversation = vi.fn()
    const onAskSelectionInSidebar = vi.fn()
    render(
      <MessageList
        messages={[
          {
            id: 'assistant-selection',
            role: 'assistant',
            content: 'Select this response',
            status: 'done',
            createdAt: '2026-07-15T10:00:00Z',
          },
        ]}
        onAddSelectionToConversation={onAddSelectionToConversation}
        onAskSelectionInSidebar={onAskSelectionInSidebar}
      />
    )

    selectText(screen.getByTestId('assistant-message-content'), 'Select this')

    expect(await screen.findByTestId('message-selection-actions')).toBeInTheDocument()
    await userEvent.click(screen.getByTestId('add-selection-to-conversation-button'))
    expect(onAddSelectionToConversation).toHaveBeenCalledWith('Select this')
    expect(screen.queryByTestId('message-selection-actions')).not.toBeInTheDocument()

    selectText(screen.getByTestId('assistant-message-content'), 'response')
    await userEvent.click(await screen.findByTestId('ask-selection-in-sidebar-button'))
    expect(onAskSelectionInSidebar).toHaveBeenCalledWith('response')
  })

  test('does not offer selection actions across message bodies', () => {
    render(
      <MessageList
        messages={[
          {
            id: 'user-selection',
            role: 'user',
            content: 'First message',
            status: 'done',
            createdAt: '2026-07-15T10:00:00Z',
          },
          {
            id: 'assistant-selection',
            role: 'assistant',
            content: 'Second message',
            status: 'done',
            createdAt: '2026-07-15T10:00:01Z',
          },
        ]}
        onAddSelectionToConversation={vi.fn()}
        onAskSelectionInSidebar={vi.fn()}
      />
    )

    const range = document.createRange()
    range.setStart(firstTextNode(screen.getByTestId('user-message-content')), 0)
    range.setEnd(firstTextNode(screen.getByTestId('assistant-message-content')), 6)
    setDocumentSelection(range)

    expect(screen.queryByTestId('message-selection-actions')).not.toBeInTheDocument()
  })

  test('reads the final selection after a mouse interaction completes', async () => {
    render(
      <MessageList
        messages={[
          {
            id: 'assistant-mouse-selection',
            role: 'assistant',
            content: 'Select this response',
            status: 'done',
            createdAt: '2026-07-15T10:00:00Z',
          },
        ]}
        onAddSelectionToConversation={vi.fn()}
        onAskSelectionInSidebar={vi.fn()}
      />
    )

    const content = screen.getByTestId('assistant-message-content')
    const range = document.createRange()
    range.setStart(firstTextNode(content), 0)
    range.setEnd(firstTextNode(content), 6)
    document.getSelection()?.removeAllRanges()
    document.getSelection()?.addRange(range)
    fireEvent.mouseUp(content)

    expect(await screen.findByTestId('message-selection-actions')).toBeInTheDocument()
  })

  test('keeps captured selection actions when streaming replaces the selected text node', async () => {
    const onAddSelectionToConversation = vi.fn()
    const { rerender } = render(
      <MessageList
        messages={[
          {
            id: 'assistant-streaming-selection',
            role: 'assistant',
            content: 'Select this response',
            status: 'streaming',
            createdAt: '2026-07-15T10:00:00Z',
          },
        ]}
        onAddSelectionToConversation={onAddSelectionToConversation}
        onAskSelectionInSidebar={vi.fn()}
      />
    )

    const content = screen.getByTestId('assistant-message-content')
    const range = document.createRange()
    range.setStart(firstTextNode(content), 0)
    range.setEnd(firstTextNode(content), 6)
    document.getSelection()?.removeAllRanges()
    document.getSelection()?.addRange(range)
    fireEvent.pointerUp(content)

    expect(await screen.findByTestId('message-selection-actions')).toBeInTheDocument()

    rerender(
      <MessageList
        messages={[
          {
            id: 'assistant-streaming-selection',
            role: 'assistant',
            content: 'Select this response while it grows',
            status: 'streaming',
            createdAt: '2026-07-15T10:00:00Z',
          },
        ]}
        onAddSelectionToConversation={onAddSelectionToConversation}
        onAskSelectionInSidebar={vi.fn()}
      />
    )
    document.getSelection()?.removeAllRanges()
    fireEvent(document, new Event('selectionchange'))

    expect(await screen.findByTestId('message-selection-actions')).toBeInTheDocument()
    await userEvent.click(screen.getByTestId('add-selection-to-conversation-button'))
    expect(onAddSelectionToConversation).toHaveBeenCalledWith('Select')
  })

  test('offers selection actions when the whole message body is selected', async () => {
    render(
      <MessageList
        messages={[
          {
            id: 'user-before-whole-body-selection',
            role: 'user',
            content: 'Previous message',
            status: 'done',
            createdAt: '2026-07-15T09:59:59Z',
          },
          {
            id: 'assistant-whole-body-selection',
            role: 'assistant',
            content: 'Select the whole paragraph',
            status: 'done',
            createdAt: '2026-07-15T10:00:00Z',
          },
        ]}
        onAddSelectionToConversation={vi.fn()}
        onAskSelectionInSidebar={vi.fn()}
      />
    )

    const content = screen.getByTestId('assistant-message-content')
    const nextMessage = screen.getByTestId('user-message-content')
    const range = document.createRange()
    range.setStart(firstTextNode(nextMessage), 0)
    range.setEnd(firstTextNode(content), 0)
    setDocumentSelection(range)

    expect(await screen.findByTestId('message-selection-actions')).toBeInTheDocument()
  })

  test('renders generated image artifacts and opens an enlarged preview', async () => {
    render(
      <MessageList
        messages={[
          {
            id: 'assistant-image',
            role: 'assistant',
            content: 'Choose a direction.',
            status: 'done',
            createdAt: '2026-06-11T10:00:01Z',
            blocks: [
              {
                id: 'ig-1',
                subtaskId: '1',
                type: 'tool',
                toolName: 'image_generation',
                renderPayload: {
                  kind: 'image_generation',
                  imageBase64:
                    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M/wHwAF/gL+XwY7WQAAAABJRU5ErkJggg==',
                  revisedPrompt: 'Minimal dashboard concept',
                },
                status: 'done',
                createdAt: Date.now(),
              },
            ],
          },
        ]}
      />
    )

    const image = await screen.findByTestId('generated-image')
    expect(image).toHaveAttribute(
      'src',
      'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M/wHwAF/gL+XwY7WQAAAABJRU5ErkJggg=='
    )
    expect(image).toHaveAttribute('alt', 'Minimal dashboard concept')

    await userEvent.click(screen.getByTestId('generated-image-preview-button'))

    expect(await screen.findByTestId('attachment-image-lightbox')).toBeInTheDocument()
    expect(await screen.findByTestId('attachment-image-lightbox-image')).toHaveAttribute(
      'src',
      'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M/wHwAF/gL+XwY7WQAAAABJRU5ErkJggg=='
    )
    expect(screen.getByTestId('attachment-image-lightbox-image')).toHaveAttribute(
      'alt',
      'Minimal dashboard concept'
    )

    await userEvent.click(screen.getByTestId('attachment-image-zoom-in'))
    expect(screen.getByTestId('attachment-image-zoom-value')).toHaveTextContent('125%')

    fireEvent.pointerEnter(screen.getByTestId('message-hover-region'))

    expect(screen.getByTestId('attachment-image-zoom-value')).toHaveTextContent('125%')
  })

  test('uses browser-native content visibility without message window placeholders', () => {
    render(
      <MessageList
        messages={[
          {
            id: 'user-contained',
            role: 'user',
            content: 'hello',
            status: 'done',
            createdAt: '2026-06-11T10:00:00Z',
          },
          {
            id: 'assistant-contained',
            role: 'assistant',
            content: 'world',
            status: 'done',
            createdAt: '2026-06-11T10:00:01Z',
          },
        ]}
      />
    )

    expect(screen.getByTestId('message-user').className).toContain('[content-visibility:auto]')
    expect(screen.getByTestId('message-assistant').className).toContain('[content-visibility:auto]')
    expect(screen.getByTestId('message-user')).toHaveTextContent('hello')
    expect(screen.getByTestId('message-assistant')).toHaveTextContent('world')
    expect(screen.getByTestId('message-user').style.containIntrinsicSize).toBe('')
    expect(screen.getByTestId('message-assistant').style.containIntrinsicSize).toBe('')
  })

  test('does not use message row content visibility in the Tauri app', () => {
    tauriCoreMock.isTauri.mockReturnValue(true)
    const getSelectionSpy = vi.spyOn(document, 'getSelection')

    try {
      render(
        <MessageList
          messages={[
            {
              id: 'assistant-tauri-contained',
              role: 'assistant',
              content: 'Tauri text selection should stay native.',
              status: 'done',
              createdAt: '2026-06-11T10:00:01Z',
            },
          ]}
        />
      )

      const article = screen.getByTestId('message-assistant')
      const paragraph = screen.getByText('Tauri text selection should stay native.')
      expect(article.className).not.toContain('[content-visibility:auto]')
      expect(article.style.getPropertyValue('contain-intrinsic-size')).toBe('')

      fireEvent.pointerDown(paragraph, { button: 0, detail: 1 })
      fireEvent.pointerDown(paragraph, { button: 0, detail: 2 })
      fireEvent(document, new Event('selectionchange'))

      expect(getSelectionSpy).not.toHaveBeenCalled()
      expect(article.className).not.toContain('[content-visibility:auto]')
      expect(article.style.contentVisibility).toBe('')
    } finally {
      getSelectionSpy.mockRestore()
    }
  })

  test('keeps oversized streaming Markdown chunks mounted without blank placeholders', () => {
    tauriCoreMock.isTauri.mockReturnValue(true)
    class IntersectionObserverMock {
      constructor() {}
      observe = vi.fn()
      disconnect = vi.fn()
      unobserve = vi.fn()
      takeRecords = vi.fn(() => [])
      root = null
      rootMargin = '800px 0px'
      thresholds = [0]
    }
    vi.stubGlobal('IntersectionObserver', IntersectionObserverMock)
    const content = Array.from(
      { length: 60 },
      (_, index) => `### Streaming section ${index + 1}\n\n${'content '.repeat(40)}\n`
    ).join('\n')

    const { container } = render(
      <MessageList
        messages={[
          {
            id: 'assistant-streaming-windowed',
            role: 'assistant',
            content,
            status: 'streaming',
            createdAt: '2026-06-11T10:00:00Z',
          },
        ]}
      />
    )

    const chunks = Array.from(container.querySelectorAll('[data-markdown-window-chunk]'))
    expect(chunks.length).toBeGreaterThan(2)
    expect(chunks[0]).not.toBeEmptyDOMElement()
    expect(chunks.at(-1)).not.toBeEmptyDOMElement()
    expect(chunks.every(chunk => chunk.childElementCount > 0)).toBe(true)
  })

  test('keeps message row containment during a plain text click', () => {
    const getSelectionSpy = vi.spyOn(document, 'getSelection')
    getSelectionSpy.mockReturnValue({
      isCollapsed: true,
      rangeCount: 0,
      anchorNode: null,
      focusNode: null,
    } as Selection)

    try {
      render(
        <MessageList
          messages={[
            {
              id: 'user-clickable',
              role: 'user',
              content: 'Click this user message.',
              status: 'done',
              createdAt: '2026-06-11T10:00:01Z',
            },
          ]}
        />
      )

      const article = screen.getByTestId('message-user')
      const content = screen.getByTestId('user-message-content')
      expect(article.className).toContain('[content-visibility:auto]')

      fireEvent.pointerDown(content, { button: 0 })
      fireEvent.pointerUp(document)

      expect(article.className).toContain('[content-visibility:auto]')
      expect(article.style.containIntrinsicSize).toBe('')
      expect(article.style.contentVisibility).toBe('')
    } finally {
      getSelectionSpy.mockRestore()
    }
  })

  test('keeps expanded process file diffs visible during selection cleanup', async () => {
    const getSelectionSpy = vi.spyOn(document, 'getSelection')
    getSelectionSpy.mockReturnValue({
      isCollapsed: true,
      rangeCount: 0,
      anchorNode: null,
      focusNode: null,
    } as Selection)
    const requestAnimationFrameSpy = vi
      .spyOn(window, 'requestAnimationFrame')
      .mockImplementation(callback => {
        callback(0)
        return 1
      })
    const blocks: ProcessingBlock[] = [
      {
        id: 'file-changes-1',
        turnId: 11,
        type: 'file_changes',
        status: 'done',
        createdAt: 1770000000000,
        fileChanges: {
          version: 1,
          status: 'active',
          artifact_id: 'artifact-1',
          device_id: 'device-1',
          workspace_path: '/tmp/project',
          file_count: 1,
          additions: 1,
          deletions: 1,
          files: [
            {
              path: 'src/config.ts',
              change_type: 'modified',
              additions: 1,
              deletions: 1,
              binary: false,
            },
          ],
          diff: [
            'diff --git a/src/config.ts b/src/config.ts',
            '--- a/src/config.ts',
            '+++ b/src/config.ts',
            '@@ -1 +1 @@',
            '-enabled: false',
            '+enabled: true',
          ].join('\n'),
        },
      },
    ]

    try {
      render(
        <MessageList
          messages={[
            {
              id: 'assistant-file-diff',
              role: 'assistant',
              content: '',
              status: 'done',
              blocks,
              createdAt: '2026-06-24T08:00:01.000Z',
            },
          ]}
        />
      )

      const article = screen.getByTestId('message-assistant')
      expect(article.className).toContain('[content-visibility:auto]')

      fireEvent.click(screen.getByRole('button', { name: /已处理/ }))
      fireEvent.click(screen.getByRole('button', { name: /编辑 config\.ts/ }))

      const diff = screen.getByTestId('process-file-change-diff')
      expect(diff).toHaveAttribute('data-message-content-visibility-lock', 'true')
      expect(article.style.contentVisibility).toBe('visible')

      fireEvent.pointerDown(diff, { button: 0 })
      fireEvent.pointerUp(document)

      await waitFor(() => {
        expect(article.style.contentVisibility).toBe('visible')
      })
    } finally {
      getSelectionSpy.mockRestore()
      requestAnimationFrameSpy.mockRestore()
    }
  })

  test('keeps message rows stable during double-click text selection', () => {
    render(
      <MessageList
        messages={[
          {
            id: 'assistant-double-click',
            role: 'assistant',
            content: 'Double click should use the browser native selection behavior.',
            status: 'done',
            createdAt: '2026-06-11T10:00:01Z',
          },
        ]}
      />
    )

    const article = screen.getByTestId('message-assistant')
    const paragraph = screen.getByText(
      'Double click should use the browser native selection behavior.'
    )

    fireEvent.pointerDown(paragraph, { button: 0, detail: 1 })
    expect(article.className).toContain('[content-visibility:auto]')
    expect(article.style.contentVisibility).toBe('')

    fireEvent.pointerDown(paragraph, { button: 0, detail: 2 })
    expect(article.className).toContain('[content-visibility:auto]')
    expect(article.style.contentVisibility).toBe('')
  })

  test('disables message row containment only while selected message text is active', async () => {
    const getSelectionSpy = vi.spyOn(document, 'getSelection')
    const requestAnimationFrameSpy = vi
      .spyOn(window, 'requestAnimationFrame')
      .mockImplementation(callback => {
        callback(0)
        return 1
      })

    try {
      render(
        <MessageList
          messages={[
            {
              id: 'assistant-selectable',
              role: 'assistant',
              content: 'Select this assistant paragraph.',
              status: 'done',
              createdAt: '2026-06-11T10:00:01Z',
            },
          ]}
        />
      )

      const article = screen.getByTestId('message-assistant')
      const paragraph = screen.getByText('Select this assistant paragraph.')
      const textNode = paragraph.firstChild
      expect(article.className).toContain('[content-visibility:auto]')

      getSelectionSpy.mockReturnValue({
        isCollapsed: false,
        rangeCount: 1,
        anchorNode: textNode,
        focusNode: textNode,
      } as Selection)
      fireEvent(document, new Event('selectionchange'))

      await waitFor(() => {
        expect(article.className).not.toContain('[content-visibility:auto]')
        expect(article.style.getPropertyValue('contain-intrinsic-size')).toBe('')
      })

      getSelectionSpy.mockReturnValue({
        isCollapsed: true,
        rangeCount: 0,
        anchorNode: null,
        focusNode: null,
      } as Selection)
      fireEvent.pointerUp(document)

      await waitFor(() => {
        expect(article.className).toContain('[content-visibility:auto]')
        expect(article.style.containIntrinsicSize).toBe('')
      })
    } finally {
      getSelectionSpy.mockRestore()
      requestAnimationFrameSpy.mockRestore()
    }
  })

  test('renders one assistant turn file changes under its message', () => {
    render(
      <MessageList
        devices={[
          {
            id: 1,
            device_id: 'device-1',
            name: 'Device 1',
            status: 'online',
            is_default: false,
          },
        ]}
        onLoadFileChangesDiff={vi.fn().mockResolvedValue('')}
        onRevertFileChanges={vi.fn()}
        messages={[
          {
            id: 'assistant-21',
            subtaskId: 21,
            role: 'assistant',
            content: 'Done',
            status: 'done',
            createdAt: '2026-06-11T10:00:00Z',
            fileChanges: {
              version: 1,
              status: 'active',
              artifact_id: 'turn-21',
              device_id: 'device-1',
              workspace_path: '/workspace/project',
              file_count: 1,
              additions: 4,
              deletions: 2,
              files: [
                {
                  path: 'src/main.ts',
                  change_type: 'modified',
                  additions: 4,
                  deletions: 2,
                  binary: false,
                },
              ],
            },
          },
        ]}
      />
    )

    expect(screen.getByTestId('file-changes-card')).toHaveTextContent('已编辑 main.ts')
    expect(screen.getByTestId('file-changes-card')).toHaveTextContent('查看更改')
  })

  test('does not show file change hover diff for the turn currently open in review', () => {
    vi.useFakeTimers()
    try {
      const onOpenFileChangesReview = vi.fn()
      render(
        <MessageList
          fileChangesDiffPreviewDisabledSubtaskId="42"
          devices={[
            {
              id: 1,
              device_id: 'device-1',
              name: 'Device 1',
              status: 'online',
              is_default: false,
            },
          ]}
          onLoadFileChangesDiff={vi.fn().mockResolvedValue('')}
          onRevertFileChanges={vi.fn()}
          onOpenFileChangesReview={onOpenFileChangesReview}
          messages={[
            {
              id: 'assistant-42',
              subtaskId: '42',
              role: 'assistant',
              content: 'Done',
              status: 'done',
              createdAt: '2026-06-11T10:00:00Z',
              fileChanges: {
                version: 1,
                status: 'active',
                artifact_id: 'turn-42',
                device_id: 'device-1',
                workspace_path: '/workspace/project',
                file_count: 1,
                additions: 1,
                deletions: 1,
                files: [
                  {
                    path: 'renderer/src/components/chat/FileChangesCard.tsx',
                    change_type: 'modified',
                    additions: 1,
                    deletions: 1,
                    binary: false,
                  },
                ],
                diff: [
                  'diff --git a/renderer/src/components/chat/FileChangesCard.tsx b/renderer/src/components/chat/FileChangesCard.tsx',
                  '--- a/renderer/src/components/chat/FileChangesCard.tsx',
                  '+++ b/renderer/src/components/chat/FileChangesCard.tsx',
                  '@@ -1 +1 @@',
                  '-old component',
                  '+new component',
                ].join('\n'),
              },
            },
          ]}
        />
      )

      fireEvent.pointerEnter(screen.getByTestId('file-change-trigger'))
      act(() => vi.advanceTimersByTime(500))
      expect(screen.queryByTestId('file-change-diff-preview')).not.toBeInTheDocument()

      fireEvent.click(screen.getByRole('button', { name: /FileChangesCard\.tsx/ }))
      expect(onOpenFileChangesReview).toHaveBeenCalledTimes(1)
      expect(onOpenFileChangesReview.mock.calls[0][0].subtaskId).toBe('42')
      expect(onOpenFileChangesReview.mock.calls[0][0].focusFilePath).toBe(
        'renderer/src/components/chat/FileChangesCard.tsx'
      )
    } finally {
      vi.useRealTimers()
    }
  })

  test('renders cancelled assistant turns with a stopped state', () => {
    const commandBlock: ProcessingBlock = {
      id: 'call-1',
      subtaskId: 21,
      type: 'tool',
      toolName: 'Bash',
      toolInput: { command: 'pnpm test' },
      status: 'done',
      createdAt: Date.parse('2026-06-11T10:09:18Z'),
    }

    render(
      <MessageList
        devices={[
          {
            id: 1,
            device_id: 'device-1',
            name: 'Device 1',
            status: 'online',
            is_default: false,
          },
        ]}
        onLoadFileChangesDiff={vi.fn().mockResolvedValue('')}
        onRevertFileChanges={vi.fn()}
        messages={[
          {
            id: 'assistant-stopped',
            subtaskId: 21,
            role: 'assistant',
            content: 'interrupted',
            status: 'done',
            runtimeStatus: 'cancelled',
            createdAt: '2026-06-11T10:00:00Z',
            blocks: [commandBlock],
            fileChanges: {
              version: 1,
              status: 'active',
              artifact_id: 'turn-21',
              device_id: 'device-1',
              workspace_path: '/workspace/project',
              file_count: 1,
              additions: 4,
              deletions: 2,
              files: [
                {
                  path: 'src/main.ts',
                  change_type: 'modified',
                  additions: 4,
                  deletions: 2,
                  binary: false,
                },
              ],
            },
          },
        ]}
      />
    )

    expect(screen.queryByText('interrupted')).not.toBeInTheDocument()
    const summary = screen.getByRole('button', { name: /调用 1 个工具 已处理/ })
    expect(summary).toHaveAttribute('aria-expanded', 'false')
    fireEvent.click(summary)
    expect(screen.getByText('运行 pnpm test')).toBeInTheDocument()
    expect(screen.queryByTestId('processing-activity-group-toggle')).not.toBeInTheDocument()
    expect(screen.getByTestId('file-changes-card')).toHaveTextContent('已编辑 main.ts')
    const stoppedNotice = screen.getByTestId('assistant-stopped-notice')
    expect(stoppedNotice).toHaveTextContent('你在 9m 18s 后停止了')
    expect(stoppedNotice).not.toHaveClass('border-b')
  })

  test('does not render a failure card when a cancelled turn still carries an error payload', () => {
    render(
      <MessageList
        messages={[
          {
            id: 'assistant-user-stopped-error',
            subtaskId: 22,
            role: 'assistant',
            content: 'cancelled by user',
            status: 'failed',
            runtimeStatus: 'cancelled',
            error: 'cancelled by user',
            createdAt: '2026-06-11T10:00:00Z',
          },
        ]}
      />
    )

    expect(screen.getByTestId('assistant-stopped-notice')).toHaveTextContent('已停止')
    expect(screen.queryByTestId('assistant-error-card')).not.toBeInTheDocument()
    expect(screen.queryByTestId('assistant-error-retry')).not.toBeInTheDocument()
  })

  test('keeps late cancelled output without rendering it as active thinking', () => {
    render(
      <MessageList
        messages={[
          {
            id: 'assistant-cancelled-late-output',
            subtaskId: 21,
            role: 'assistant',
            content: '取消后仍收到的模型输出。',
            status: 'streaming',
            runtimeStatus: 'cancelled',
            createdAt: '2026-06-11T10:00:00Z',
            blocks: [
              {
                id: 'late-process',
                subtaskId: 21,
                type: 'text',
                content: '补充分析。',
                status: 'streaming',
                createdAt: Date.parse('2026-06-11T10:00:10Z'),
              },
            ],
          },
        ]}
      />
    )

    expect(screen.getByText('取消后仍收到的模型输出。')).toBeInTheDocument()
    expect(screen.getByText('补充分析。')).toBeInTheDocument()
    expect(screen.queryByTestId('thinking-indicator')).not.toBeInTheDocument()
  })

  test('renders tagged proposed plan content as regular assistant markdown', () => {
    render(
      <MessageList
        messages={[
          {
            id: 'assistant-plan',
            role: 'assistant',
            content:
              '<proposed_plan>\n1. Inspect the desktop chat width.\n2. Match the reference task.\n</proposed_plan>',
            status: 'streaming',
            createdAt: '2026-06-11T10:00:00Z',
          },
        ]}
      />
    )

    expect(screen.queryByTestId('assistant-plan-card')).not.toBeInTheDocument()
    const planItems = screen.getAllByRole('listitem')
    expect(planItems.map(item => item.textContent)).toEqual([
      'Inspect the desktop chat width.',
      'Match the reference task.',
    ])
    expect(screen.queryByText(/proposed_plan/)).not.toBeInTheDocument()
  })

  test('renders Codex plan implementation user messages as the chosen option label', () => {
    render(
      <MessageList
        messages={[
          {
            id: 'user-plan-implementation',
            role: 'user',
            content: [
              'PLEASE IMPLEMENT THIS PLAN:',
              '# Wework 输入框 Codex 化视觉优化计划',
              '',
              '## Summary',
              '- 保持输入框视觉与 Codex App 一致。',
            ].join('\n'),
            status: 'done',
            createdAt: '2026-06-11T10:00:00Z',
          },
        ]}
      />
    )

    expect(screen.getByTestId('user-message-content')).toHaveTextContent('是的，执行此计划')
    expect(screen.queryByText(/PLEASE IMPLEMENT THIS PLAN/)).not.toBeInTheDocument()
    expect(screen.queryByText(/Wework 输入框 Codex 化视觉优化计划/)).not.toBeInTheDocument()
    expect(screen.queryByTestId('toggle-user-message-button')).not.toBeInTheDocument()
  })

  test('renders answered request user input as an assistant question summary', () => {
    render(
      <MessageList
        messages={[
          {
            id: 'assistant-question',
            role: 'assistant',
            content: '',
            status: 'streaming',
            createdAt: '2026-06-11T10:00:00Z',
            blocks: [
              {
                id: 'request-1',
                subtaskId: 11,
                type: 'tool',
                toolName: 'request_user_input',
                status: 'done',
                createdAt: Date.parse('2026-06-11T10:00:00Z'),
                renderPayload: {
                  kind: 'request_user_input',
                  request_id: 42,
                  questions: [
                    {
                      id: 'direction',
                      question: '这个计划想落在哪个方向?',
                    },
                  ],
                  response: {
                    requestId: 42,
                    answers: {
                      direction: { answers: ['随便，我就想看看样式'] },
                    },
                  },
                },
              },
            ],
          },
        ]}
      />
    )

    expect(screen.getByTestId('request-user-input-summary')).toHaveTextContent('已询问 1 个问题')
    expect(screen.getByText('这个计划想落在哪个方向?')).toBeInTheDocument()
    expect(screen.getByText('随便，我就想看看样式')).toBeInTheDocument()
    expect(screen.queryByTestId('message-user')).not.toBeInTheDocument()
  })

  test('restores an answered question inside the expandable completed process', () => {
    render(
      <MessageList
        messages={[
          {
            id: 'assistant-question-history',
            role: 'assistant',
            content: 'SELECTED_BETA',
            status: 'done',
            createdAt: '2026-06-11T10:00:00Z',
            blocks: [
              {
                id: 'question-call-1',
                subtaskId: 12,
                type: 'tool',
                toolName: 'AskUserQuestion',
                status: 'done',
                createdAt: Date.parse('2026-06-11T10:00:00Z'),
                renderPayload: {
                  kind: 'request_user_input',
                  itemId: 'question-call-1',
                  questions: [
                    {
                      id: 'question-1',
                      question: 'Which option should be used?',
                    },
                  ],
                  response: {
                    itemId: 'question-call-1',
                    answers: {
                      'question-1': { answers: ['BETA'] },
                    },
                  },
                },
              },
            ],
          },
        ]}
      />
    )

    const toggle = screen.getByTestId('final-processing-toggle')
    expect(toggle).toHaveAttribute('aria-expanded', 'false')
    expect(screen.queryByTestId('request-user-input-summary')).not.toBeInTheDocument()

    fireEvent.click(toggle)

    expect(toggle).toHaveAttribute('aria-expanded', 'true')
    expect(screen.getByTestId('request-user-input-summary')).toHaveTextContent(
      'Which option should be used?'
    )
    expect(screen.getByTestId('request-user-input-summary')).toHaveTextContent('BETA')
  })

  test('renders explicit plan blocks as an assistant plan card', async () => {
    const user = userEvent.setup()
    const writeText = vi.fn().mockResolvedValue(undefined)
    const onOpenAssistantPlan = vi.fn()
    const planContent = [
      '# Wegent 代码质量与前端一致性巡检计划',
      '',
      '## Summary',
      '- 目标：做一轮低风险工程改进。',
      '',
      '## Key Changes',
      '- 扫描前端直接导入。',
      '',
      '## Test Plan',
      '- 运行 lint。',
    ].join('\n')
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText },
    })

    render(
      <MessageList
        onOpenAssistantPlan={onOpenAssistantPlan}
        messages={[
          {
            id: 'assistant-plan-block',
            role: 'assistant',
            content: '',
            status: 'done',
            createdAt: '2026-06-11T10:00:00Z',
            blocks: [
              {
                id: 'plan-1',
                subtaskId: 11,
                type: 'plan',
                content: planContent,
                status: 'done',
                createdAt: Date.parse('2026-06-11T10:00:00Z'),
              },
            ],
          },
        ]}
      />
    )

    const planCard = screen.getByTestId('assistant-plan-card')
    expect(planCard).toHaveTextContent('计划')
    expect(screen.queryByTestId('assistant-plan-streaming-indicator')).not.toBeInTheDocument()
    expect(planCard).toHaveAttribute('role', 'button')
    expect(screen.getByTestId('assistant-plan-card-preview').className).toContain('max-h-[168px]')
    expect(screen.getByTestId('assistant-plan-card-content').className).toContain('text-sm')
    expect(screen.queryByText('套餐')).not.toBeInTheDocument()
    expect(screen.queryByTestId('assistant-plan-like-button')).not.toBeInTheDocument()
    expect(screen.queryByTestId('assistant-plan-dislike-button')).not.toBeInTheDocument()
    URL.createObjectURL = vi.fn(() => 'blob:assistant-plan-markdown')
    URL.revokeObjectURL = vi.fn()
    await user.click(screen.getByTestId('assistant-plan-download-button'))
    expect(URL.createObjectURL).toHaveBeenCalledWith(expect.any(Blob))
    await user.click(screen.getByTestId('assistant-plan-copy-button'))
    expect(writeText).toHaveBeenCalledWith(
      expect.stringContaining('Wegent 代码质量与前端一致性巡检计划')
    )
    expect(await screen.findByTestId('assistant-plan-copy-success')).toHaveTextContent('已复制')
    expect(onOpenAssistantPlan).not.toHaveBeenCalled()
    await user.click(planCard)
    expect(onOpenAssistantPlan).toHaveBeenCalledWith({
      blockId: 'plan-1',
      subtaskId: '11',
      content: expect.stringContaining('Wegent 代码质量与前端一致性巡检计划'),
    })
    await user.click(screen.getByTestId('assistant-plan-expand-button'))
    expect(onOpenAssistantPlan).toHaveBeenLastCalledWith({
      blockId: 'plan-1',
      subtaskId: '11',
      content: expect.stringContaining('Wegent 代码质量与前端一致性巡检计划'),
    })
    expect(onOpenAssistantPlan).toHaveBeenCalledTimes(2)
    expect(screen.queryByTestId('assistant-plan-reading-panel')).not.toBeInTheDocument()
  })

  test('downloads explicit plan blocks through the Tauri native command', async () => {
    tauriCoreMock.isTauri.mockReturnValue(true)
    tauriCoreMock.invoke = vi.fn().mockResolvedValue('/Users/test/Downloads/plan.md')

    render(
      <MessageList
        messages={[
          {
            id: 'assistant-plan-block',
            role: 'assistant',
            content: '',
            status: 'done',
            createdAt: '2026-06-11T10:00:00Z',
            blocks: [
              {
                id: 'plan-1',
                subtaskId: 11,
                type: 'plan',
                content: '# Native plan\n\n- Save through Tauri.',
                status: 'done',
                createdAt: Date.parse('2026-06-11T10:00:00Z'),
              },
            ],
          },
        ]}
      />
    )

    await userEvent.click(screen.getByTestId('assistant-plan-download-button'))

    await waitFor(() => {
      expect(tauriCoreMock.invoke).toHaveBeenCalledWith('save_text_file_to_downloads', {
        filename: 'plan.md',
        content: '# Native plan\n\n- Save through Tauri.',
      })
    })
  })

  test('downloads explicit plan blocks in Gateway Web without invoking a native command', async () => {
    tauriCoreMock.isTauri.mockReturnValue(true)
    ;(
      window as typeof window & { __KCODER_GATEWAY_WEB_SHIM__?: boolean }
    ).__KCODER_GATEWAY_WEB_SHIM__ = true
    URL.createObjectURL = vi.fn(() => 'blob:gateway-plan-markdown')
    URL.revokeObjectURL = vi.fn()

    render(
      <MessageList
        messages={[
          {
            id: 'assistant-gateway-plan-block',
            role: 'assistant',
            content: '',
            status: 'done',
            createdAt: '2026-06-11T10:00:00Z',
            blocks: [
              {
                id: 'plan-gateway',
                subtaskId: 11,
                type: 'plan',
                content: '# Gateway plan\n\n- Save through the browser.',
                status: 'done',
                createdAt: Date.parse('2026-06-11T10:00:00Z'),
              },
            ],
          },
        ]}
      />
    )

    await userEvent.click(screen.getByTestId('assistant-plan-download-button'))

    expect(tauriCoreMock.invoke).not.toHaveBeenCalled()
    expect(URL.createObjectURL).toHaveBeenCalledWith(expect.any(Blob))
  })

  test('renders streaming plan blocks as an assistant plan card', () => {
    render(
      <MessageList
        messages={[
          {
            id: 'assistant-streaming-plan-block',
            role: 'assistant',
            content: '',
            status: 'streaming',
            createdAt: '2026-06-11T10:00:00Z',
            blocks: [
              {
                id: 'plan-streaming',
                subtaskId: 11,
                type: 'plan',
                content: '# 流式计划\n\n- 正在生成第一步。',
                status: 'streaming',
                createdAt: Date.parse('2026-06-11T10:00:00Z'),
              },
            ],
          },
        ]}
      />
    )

    expect(screen.getByTestId('assistant-plan-card')).toHaveTextContent('流式计划')
    expect(screen.getByTestId('assistant-plan-card')).toHaveTextContent('正在生成第一步')
    expect(screen.getByTestId('assistant-plan-streaming-indicator')).toHaveTextContent('正在生成')
  })

  test('renders untagged streaming plan-shaped markdown as regular assistant markdown', () => {
    render(
      <MessageList
        messages={[
          {
            id: 'assistant-untagged-plan',
            role: 'assistant',
            content: [
              '# Wegent 代码质量与前端一致性巡检计划',
              '',
              '## Summary',
              '- 目标：做一轮低风险工程改进。',
              '',
              '## Test Plan',
              '- 运行 lint。',
            ].join('\n'),
            status: 'streaming',
            createdAt: '2026-06-11T10:00:00Z',
          },
        ]}
      />
    )

    expect(screen.queryByTestId('assistant-plan-card')).not.toBeInTheDocument()
    expect(
      screen.getByRole('heading', { level: 1, name: 'Wegent 代码质量与前端一致性巡检计划' })
    ).toBeInTheDocument()
  })

  test('shows thinking after partial streaming assistant content becomes visible', () => {
    render(
      <MessageList
        messages={[
          {
            id: 'assistant-streaming-with-content',
            role: 'assistant',
            content: '我已经完成前面的检查，继续等最后结果。',
            status: 'streaming',
            createdAt: '2026-06-11T10:00:00Z',
          },
        ]}
      />
    )

    const content = screen.getByTestId('message-assistant').querySelector('p')
    expect(content).toHaveTextContent('我已经完成前面的检查，继续等最后结果。')
    expect(screen.queryByTestId('thinking-indicator')).not.toBeInTheDocument()
  })

  test('shows only the running block after partial content', () => {
    const runningSearchBlock: ProcessingBlock = {
      id: 'search-running',
      subtaskId: 1,
      type: 'tool',
      toolName: 'bash',
      toolInput: { command: 'rg -n chat src' },
      status: 'streaming',
      createdAt: 1770000000000,
    }

    render(
      <MessageList
        messages={[
          {
            id: 'assistant-done-with-running-block',
            role: 'assistant',
            content: '我先把硬编码中文改成 chat 命名空间翻译。',
            status: 'done',
            createdAt: '2026-06-11T10:00:00Z',
            blocks: [runningSearchBlock],
          },
        ]}
      />
    )

    expect(screen.getByText('我先把硬编码中文改成 chat 命名空间翻译。')).toBeInTheDocument()
    expect(screen.getByText('正在搜索代码')).toHaveClass('tool-activity-shimmer')
    expect(screen.queryByTestId('thinking-indicator')).not.toBeInTheDocument()
  })

  test('renders tagged markdown documents as regular assistant markdown instead of a plan card', () => {
    render(
      <MessageList
        messages={[
          {
            id: 'assistant-tagged-markdown-document',
            role: 'assistant',
            content: [
              '<proposed_plan>',
              '```md',
              '# 产品需求文档示例',
              '',
              '## 概述',
              '本文档用于描述一个轻量级任务管理工具的核心需求。',
              '```',
              '</proposed_plan>',
            ].join('\n'),
            status: 'done',
            createdAt: '2026-06-11T10:00:00Z',
          },
        ]}
      />
    )

    expect(screen.queryByTestId('assistant-plan-card')).not.toBeInTheDocument()
    expect(screen.getByTestId('markdown-code-block-language')).toHaveTextContent('md')
    expect(screen.getByTestId('markdown-code-block')).toHaveTextContent('产品需求文档示例')
  })

  test('renders streaming tagged markdown documents without a plan card', () => {
    render(
      <MessageList
        messages={[
          {
            id: 'assistant-streaming-tagged-markdown-document',
            role: 'assistant',
            content: [
              '<proposed_plan>',
              '```md',
              '# 产品需求文档示例',
              '',
              '## 概述',
              '本文档用于描述一个轻量级任务管理工具的核心需求。',
            ].join('\n'),
            status: 'streaming',
            createdAt: '2026-06-11T10:00:00Z',
          },
        ]}
      />
    )

    expect(screen.queryByTestId('assistant-plan-card')).not.toBeInTheDocument()
    expect(screen.getByTestId('markdown-code-block-language')).toHaveTextContent('md')
    expect(screen.getByTestId('markdown-code-block')).toHaveTextContent('产品需求文档示例')
  })

  test('shows stopped duration from completed time and keeps partial assistant content', () => {
    render(
      <MessageList
        messages={[
          {
            id: 'assistant-stopped-with-content',
            role: 'assistant',
            content: '停止前已经生成的内容。',
            status: 'done',
            runtimeStatus: 'cancelled',
            createdAt: '2026-06-11T10:00:00Z',
            completedAt: '2026-06-11T10:02:12Z',
          },
        ]}
      />
    )

    expect(screen.getByTestId('assistant-stopped-notice')).toHaveTextContent('你在 2m 12s 后停止了')
    expect(screen.getByText('停止前已经生成的内容。')).toBeInTheDocument()
    expect(screen.queryByText(/已处理/)).not.toBeInTheDocument()
  })

  test('renders stopped assistant process text and activity rows in original order', () => {
    const blocks: ProcessingBlock[] = [
      {
        id: 'process-1',
        subtaskId: 21,
        type: 'text',
        content: '我先看你提到的 package.json。',
        status: 'done',
        createdAt: Date.parse('2026-06-11T10:00:10Z'),
      },
      {
        id: 'call-1',
        subtaskId: 21,
        type: 'tool',
        toolName: 'Bash',
        toolInput: { command: 'cat package.json' },
        status: 'done',
        createdAt: Date.parse('2026-06-11T10:00:20Z'),
      },
      {
        id: 'process-2',
        subtaskId: 21,
        type: 'text',
        content: '从常用目录看，可能的前端仓库很多。',
        status: 'done',
        createdAt: Date.parse('2026-06-11T10:00:30Z'),
      },
    ]

    render(
      <MessageList
        messages={[
          {
            id: 'assistant-stopped-interleaved',
            role: 'assistant',
            content: '',
            status: 'done',
            runtimeStatus: 'cancelled',
            createdAt: '2026-06-11T10:00:00Z',
            completedAt: '2026-06-11T10:02:12Z',
            blocks,
          },
        ]}
      />
    )

    const firstText = screen.getByText('我先看你提到的 package.json。')
    const summary = screen.getByRole('button', { name: /调用 1 个工具 已处理/ })
    const secondText = screen.getByText('从常用目录看，可能的前端仓库很多。')

    expect(screen.getByTestId('assistant-stopped-notice')).toHaveTextContent('你在 2m 12s 后停止了')
    expect(summary).toHaveAttribute('aria-expanded', 'false')
    expect(firstText.compareDocumentPosition(summary) & Node.DOCUMENT_POSITION_FOLLOWING).toBe(
      Node.DOCUMENT_POSITION_FOLLOWING
    )
    expect(summary.compareDocumentPosition(secondText) & Node.DOCUMENT_POSITION_FOLLOWING).toBe(
      Node.DOCUMENT_POSITION_FOLLOWING
    )
    fireEvent.click(summary)
    expect(screen.getByText('读取 package.json')).toBeInTheDocument()
    expect(screen.queryByTestId('processing-activity-group-toggle')).not.toBeInTheDocument()
  })

  test('counts each edited file in a stopped tool summary', () => {
    const files = Array.from({ length: 4 }, (_, index) => ({
      path: `src/file-${index + 1}.ts`,
      change_type: 'modified' as const,
      additions: 1,
      deletions: 0,
      binary: false,
    }))
    const fileChangesBlock: ProcessingBlock = {
      id: 'file-changes-1',
      subtaskId: 21,
      type: 'file_changes',
      status: 'done',
      createdAt: Date.parse('2026-06-11T10:00:20Z'),
      fileChanges: {
        version: 1,
        status: 'active',
        artifact_id: 'artifact-1',
        device_id: 'device-1',
        workspace_path: '/workspace/project',
        file_count: 4,
        additions: 4,
        deletions: 0,
        files,
        reverted_at: null,
        revertible: false,
      },
    }

    render(
      <MessageList
        messages={[
          {
            id: 'assistant-stopped-file-changes',
            role: 'assistant',
            content: '',
            status: 'done',
            runtimeStatus: 'cancelled',
            createdAt: '2026-06-11T10:00:00Z',
            completedAt: '2026-06-11T10:02:12Z',
            blocks: [fileChangesBlock],
          },
        ]}
      />
    )

    expect(screen.getByRole('button', { name: /编辑 4 个文件 已处理/ })).toHaveAttribute(
      'aria-expanded',
      'false'
    )
    expect(screen.getByLabelText('编辑 4')).toBeInTheDocument()
  })

  test('shows one stopped notice for split stopped assistant turns and keeps guidance visible', () => {
    render(
      <MessageList
        messages={[
          {
            id: 'assistant-stopped-first',
            role: 'assistant',
            content: '',
            status: 'done',
            runtimeStatus: 'cancelled',
            stoppedNotice: true,
            createdAt: '2026-06-11T10:00:00Z',
            completedAt: '2026-06-11T10:02:12Z',
            blocks: [
              {
                id: 'process-1',
                subtaskId: 21,
                type: 'text',
                content: '我先看 package.json。',
                status: 'done',
                createdAt: Date.parse('2026-06-11T10:00:10Z'),
              },
            ],
          },
          {
            id: 'user-guidance',
            role: 'user',
            content: 'pnpm-lock.yaml',
            status: 'done',
            createdAt: '2026-06-11T10:01:00Z',
          },
          {
            id: 'assistant-stopped-continuation',
            role: 'assistant',
            content: '',
            status: 'done',
            runtimeStatus: 'cancelled',
            stoppedNotice: false,
            createdAt: '2026-06-11T10:00:00Z',
            completedAt: '2026-06-11T10:02:12Z',
            blocks: [
              {
                id: 'guidance-1',
                subtaskId: 21,
                type: 'tool',
                toolName: 'conversation_guidance',
                toolInput: { message: 'pnpm-lock.yaml' },
                status: 'done',
                createdAt: Date.parse('2026-06-11T10:01:00Z'),
              },
              {
                id: 'process-2',
                subtaskId: 21,
                type: 'text',
                content: '我会继续看 lockfile。',
                status: 'done',
                createdAt: Date.parse('2026-06-11T10:01:05Z'),
              },
            ],
          },
        ]}
      />
    )

    expect(screen.getAllByTestId('assistant-stopped-notice')).toHaveLength(1)
    expect(screen.getByText('我先看 package.json。')).toBeInTheDocument()
    expect(screen.getByText('pnpm-lock.yaml')).toBeInTheDocument()
    expect(screen.getByText('引导对话')).toBeInTheDocument()
    expect(screen.getByText('我会继续看 lockfile。')).toBeInTheDocument()
    expect(screen.queryByTestId('processing-summary-toggle')).not.toBeInTheDocument()
  })

  test('shows stopped notice without duration when a cancelled assistant turn has no elapsed time', () => {
    render(
      <MessageList
        messages={[
          {
            id: 'assistant-stopped-empty',
            role: 'assistant',
            content: '',
            status: 'done',
            runtimeStatus: 'cancelled',
            createdAt: '2026-06-11T10:00:00Z',
          },
        ]}
      />
    )

    expect(screen.getByTestId('assistant-stopped-notice')).toHaveTextContent('已停止')
    expect(screen.getByTestId('assistant-stopped-notice')).not.toHaveTextContent('0s')
  })

  test('uses compact spacing between messages and hover actions', () => {
    render(
      <MessageList
        messages={[
          {
            id: 'user-1',
            role: 'user',
            content: 'First message',
            status: 'done',
            createdAt: '2026-06-10T08:00:00Z',
          },
          {
            id: 'assistant-1',
            role: 'assistant',
            content: 'Second message',
            status: 'done',
            createdAt: '2026-06-10T08:01:00Z',
          },
        ]}
      />
    )

    expect(screen.getByTestId('message-user').parentElement).toHaveClass('gap-4')
    expect(screen.getByTestId('message-user').parentElement).toHaveClass('pt-8', 'pb-2')
    expect(screen.getByTestId('user-message-content')).toHaveClass('py-1.5')
    expect(screen.getAllByTestId('message-hover-actions')[0]).toHaveClass('min-h-5')
  })
})
