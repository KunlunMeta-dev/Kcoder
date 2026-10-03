import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import type { Attachment } from '@/types/api'
import { MessageList } from './MessageList'
import { WorkspaceMarkdownImageLoaderContext } from './workspaceMarkdownImageLoaderContext'
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

  beforeEach(() => {
    tauriCoreMock.convertFileSrc.mockImplementation(
      (path: string) => `asset://localhost/${path.replace(/^\/+/, '')}`
    )
  })

  afterEach(() => {
    vi.useRealTimers()
    clearPersistentProcessingExpansions()
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
    tauriCoreMock.convertFileSrc
      .mockReset()
      .mockImplementation(
        (path: string) => `asset://localhost/${path.replace(/^\/+/, '')}`
      )
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
  test('renders Discord IM source badge from channel type', () => {
    render(
      <MessageList
        messages={[
          {
            id: '1',
            role: 'user',
            content: 'Message from Discord',
            status: 'done',
            createdAt: '2026-05-25T00:00:00.000Z',
            source: {
              source: 'im',
              channel_type: 'discord',
            },
          },
        ]}
      />
    )

    expect(screen.getByTestId('message-source-badge')).toHaveTextContent('Discord')
  })

  test('does not render IM source badge for assistant or non-IM messages', () => {
    render(
      <MessageList
        messages={[
          {
            id: '1',
            role: 'assistant',
            content: '助手消息',
            status: 'done',
            createdAt: '2026-05-25T00:00:00.000Z',
            source: {
              source: 'im',
              channel_type: 'dingtalk',
              channel_label: '钉钉',
            },
          },
          {
            id: '2',
            role: 'user',
            content: '网页消息',
            status: 'done',
            createdAt: '2026-05-25T00:00:01.000Z',
            source: {
              source: 'web',
            },
          },
        ]}
      />
    )

    expect(screen.queryByTestId('message-source-badge')).not.toBeInTheDocument()
    expect(screen.queryByTestId('message-source-row')).not.toBeInTheDocument()
    expect(
      screen
        .getByText('网页消息')
        .closest('[data-testid="message-user"]')
        ?.querySelector('div.flex.min-h-5.items-center.justify-end.gap-1:not(.opacity-0)')
    ).toBeNull()
  })

  test('renders sent local skill mentions as polished inline tokens', () => {
    render(
      <MessageList
        messages={[
          {
            id: '1',
            role: 'user',
            content:
              '[$browser](skill:///Users/dev/.codex/skills/browser/SKILL.md) 访问一下浏览器',
            status: 'done',
            createdAt: '2026-05-25T00:00:00.000Z',
          },
        ]}
      />
    )

    const token = screen.getByTestId('sent-local-skill-token-browser')
    expect(token).toHaveTextContent('Browser')
    expect(screen.getByTestId('sent-local-skill-icon-browser')).toBeInTheDocument()
    expect(token).toHaveClass(
      'h-7',
      'gap-1',
      'rounded-xl',
      'bg-muted',
      'text-blue-600',
      'no-underline'
    )
    expect(screen.getByTestId('sent-local-skill-icon-browser')).toHaveClass('text-blue-600')
    expect(token).not.toHaveClass(
      'border',
      'bg-background',
      'text-text-secondary',
      'shadow-[0_1px_2px_rgba(15,23,42,0.05)]'
    )
    expect(token).not.toHaveClass('bg-primary/10', 'text-primary')
  })

  test('renders image attachments in user messages', async () => {
    URL.createObjectURL = vi.fn(() => 'blob:message-image-preview')
    URL.revokeObjectURL = vi.fn()
    localStorage.setItem('auth_token', 'token-1')
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        blob: vi.fn().mockResolvedValue(new Blob(['image'], { type: 'image/png' })),
      })
    )

    const attachment: Attachment = {
      id: 43,
      filename: 'diagram.png',
      file_size: 1024,
      mime_type: 'image/png',
      status: 'ready',
      file_extension: '.png',
      created_at: '2026-05-25T15:08:00.000+08:00',
    }

    render(
      <MessageList
        messages={[
          {
            id: '1',
            role: 'user',
            content: '分析下这个图片',
            status: 'done',
            attachments: [attachment],
            createdAt: '2026-05-25T15:08:00.000+08:00',
          },
        ]}
      />
    )

    expect(await screen.findByTestId('message-image-preview')).toHaveAttribute(
      'src',
      'blob:message-image-preview'
    )
    expect(screen.getByTestId('message-image-preview')).toHaveAttribute('alt', 'diagram.png')
    expect(fetch).toHaveBeenCalledWith(
      expect.stringContaining('/attachments/43/download'),
      expect.objectContaining({
        headers: { Authorization: 'Bearer token-1' },
      })
    )
  })

  test('uses local image attachment previews without fetching after send', async () => {
    vi.stubGlobal('fetch', vi.fn())

    const attachment: Attachment = {
      id: 43,
      filename: 'codex-clipboard.png',
      file_size: 1024,
      mime_type: 'image/png',
      status: 'ready',
      file_extension: '.png',
      created_at: '2026-05-25T15:08:00.000+08:00',
      local_preview_url: 'blob:local-sent-image',
    }

    render(
      <MessageList
        messages={[
          {
            id: '1',
            role: 'user',
            content: '发出去图片',
            status: 'done',
            attachments: [attachment],
            createdAt: '2026-05-25T15:08:00.000+08:00',
          },
        ]}
      />
    )

    expect(await screen.findByTestId('message-image-preview')).toHaveAttribute(
      'src',
      'blob:local-sent-image'
    )
    expect(fetch).not.toHaveBeenCalled()
  })

  test('keeps an attachment Blob alive when message refresh rebuilds an equivalent object', async () => {
    URL.createObjectURL = vi.fn(() => 'blob:stable-message-image')
    URL.revokeObjectURL = vi.fn()
    const fetchImage = vi.fn().mockResolvedValue({
      ok: true,
      blob: vi.fn().mockResolvedValue(new Blob(['image'], { type: 'image/png' })),
    })
    vi.stubGlobal('fetch', fetchImage)
    const attachment: Attachment = {
      id: 43,
      filename: 'diagram.png',
      file_size: 1024,
      mime_type: 'image/png',
      status: 'ready',
      file_extension: '.png',
      created_at: '2026-05-25T15:08:00.000+08:00',
    }
    const message = (nextAttachment: Attachment) => ({
      id: 'stable-attachment',
      role: 'user' as const,
      content: '分析下这个图片',
      status: 'done' as const,
      attachments: [nextAttachment],
      createdAt: '2026-05-25T15:08:00.000+08:00',
    })
    const { rerender } = render(<MessageList messages={[message(attachment)]} />)

    expect(await screen.findByTestId('message-image-preview')).toHaveAttribute(
      'src',
      'blob:stable-message-image'
    )
    await userEvent.click(screen.getByTestId('message-image-preview'))
    expect(await screen.findByTestId('attachment-image-lightbox-image')).toHaveAttribute(
      'src',
      'blob:stable-message-image'
    )
    rerender(<MessageList messages={[message({ ...attachment })]} />)

    await waitFor(() => expect(fetchImage).toHaveBeenCalledTimes(1))
    expect(URL.createObjectURL).toHaveBeenCalledTimes(1)
    expect(URL.revokeObjectURL).not.toHaveBeenCalled()
  })

  test('renders local path image attachment previews through Tauri asset URLs', async () => {
    vi.stubGlobal('fetch', vi.fn())

    const attachment: Attachment = {
      id: -1,
      filename: 'screenshot.png',
      file_size: 0,
      mime_type: 'image/png',
      status: 'ready',
      file_extension: '.png',
      created_at: '2026-06-26T15:33:00.000+08:00',
      local_preview_url: '/var/folders/tmp/codex-clipboard/screenshot.png',
    }

    render(
      <MessageList
        messages={[
          {
            id: 'local-codex-image',
            role: 'user',
            content: '解释一下些图片',
            status: 'done',
            attachments: [attachment],
            createdAt: '2026-06-26T15:33:00.000+08:00',
          },
        ]}
      />
    )

    expect(await screen.findByTestId('message-image-preview')).toHaveAttribute(
      'src',
      'asset://localhost/var/folders/tmp/codex-clipboard/screenshot.png'
    )
    expect(screen.getByTestId('message-hover-region')).toHaveClass('w-full', 'max-w-full')
    expect(screen.getByTestId('user-message-content').parentElement).toHaveClass('max-w-[80%]')
    expect(screen.getByTestId('message-image-attachments')).toHaveClass(
      'justify-end',
      'overflow-visible'
    )
    expect(screen.getByTestId('message-image-attachments')).not.toHaveClass('justify-start')
    expect(screen.getByTestId('message-image-attachment-strip')).toHaveClass(
      'ml-auto',
      'justify-end'
    )
    expect(fetch).not.toHaveBeenCalled()
  })

  test('restores historical image previews from persisted local paths', async () => {
    vi.stubGlobal('fetch', vi.fn())

    const attachment: Attachment = {
      id: -1,
      filename: 'historical.png',
      file_size: 1024,
      mime_type: 'image/png',
      status: 'ready',
      file_extension: '.png',
      created_at: '2026-06-26T15:33:00.000+08:00',
      local_path: '/Users/me/.wegent-executor/workspace/attachments/draft/42/historical.png',
    }

    render(
      <MessageList
        messages={[
          {
            id: 'historical-image',
            role: 'user',
            content: '查看历史图片',
            status: 'done',
            attachments: [attachment],
            createdAt: '2026-06-26T15:33:00.000+08:00',
          },
        ]}
      />
    )

    expect(await screen.findByTestId('message-image-preview')).toHaveAttribute(
      'src',
      'asset://localhost/Users/me/.wegent-executor/workspace/attachments/draft/42/historical.png'
    )
    expect(fetch).not.toHaveBeenCalled()
  })

  test('downloads local path image attachments through the Tauri native command', async () => {
    vi.stubGlobal('fetch', vi.fn())
    tauriCoreMock.isTauri.mockReturnValue(true)
    tauriCoreMock.invoke.mockResolvedValue('/Users/dev/Downloads/screenshot.png')

    const attachment: Attachment = {
      id: -1,
      filename: 'screenshot.png',
      file_size: 0,
      mime_type: 'image/png',
      status: 'ready',
      file_extension: '.png',
      created_at: '2026-06-26T15:33:00.000+08:00',
      local_preview_url: '/var/folders/tmp/codex-clipboard/screenshot.png',
    }

    render(
      <MessageList
        messages={[
          {
            id: 'local-codex-image',
            role: 'user',
            content: '解释一下这张图片',
            status: 'done',
            attachments: [attachment],
            createdAt: '2026-06-26T15:33:00.000+08:00',
          },
        ]}
      />
    )

    await userEvent.click(await screen.findByTestId('message-image-preview'))
    await screen.findByTestId('attachment-image-lightbox-image')
    await userEvent.click(screen.getByTestId('attachment-image-download'))

    await waitFor(() => {
      expect(tauriCoreMock.invoke).toHaveBeenCalledWith('download_local_file_to_downloads', {
        sourcePath: '/var/folders/tmp/codex-clipboard/screenshot.png',
        filename: 'screenshot.png',
      })
    })
    expect(fetch).not.toHaveBeenCalled()
  })

  test('prefers persisted image attachments over stale Codex local image mentions', async () => {
    vi.stubGlobal('fetch', vi.fn())

    const attachment: Attachment = {
      id: 43,
      filename: 'codex-clipboard.png',
      file_size: 1024,
      mime_type: 'image/png',
      status: 'ready',
      file_extension: '.png',
      created_at: '2026-05-25T15:08:00.000+08:00',
      local_preview_url: 'blob:persisted-image',
    }

    render(
      <MessageList
        messages={[
          {
            id: 'codex-image-mention-with-attachment',
            role: 'user',
            content: [
              '# Files mentioned by the user:',
              '',
              '## codex-clipboard.png: /var/folders/tmp/codex-clipboard.png',
              '',
              '## My request for Codex:',
              '发出去图片',
            ].join('\n'),
            status: 'done',
            attachments: [attachment],
            createdAt: '2026-05-25T15:08:00.000+08:00',
          },
        ]}
      />
    )

    expect(await screen.findByTestId('message-image-preview')).toHaveAttribute(
      'src',
      'blob:persisted-image'
    )
    expect(screen.queryByTestId('message-local-image-preview')).not.toBeInTheDocument()
    expect(screen.getByTestId('user-message-content')).toHaveTextContent('发出去图片')
  })

  test('renders Codex local image file mentions as user image previews after refresh', async () => {
    render(
      <MessageList
        messages={[
          {
            id: 'codex-image-mention',
            role: 'user',
            content: [
              '# Files mentioned by the user:',
              '',
              '## image.png: /Users/dev/.wegent-executor/workspace/attachments/10000000000001/0/image.png',
              '',
              '## My request for Codex:',
              '分析下这个图片',
            ].join('\n'),
            status: 'done',
            createdAt: '2026-05-25T15:08:00.000+08:00',
          },
        ]}
      />
    )

    expect(await screen.findByTestId('message-local-image-preview')).toHaveAttribute(
      'src',
      'asset://localhost/Users/dev/.wegent-executor/workspace/attachments/10000000000001/0/image.png'
    )
    expect(screen.getByTestId('user-message-content')).toHaveTextContent('分析下这个图片')
    expect(screen.queryByText(/Files mentioned by the user/)).not.toBeInTheDocument()
    expect(screen.queryByText(/My request for Codex/)).not.toBeInTheDocument()
  })

  test('renders Codex local non-image file mentions as compact file chips', () => {
    const onOpenWorkspaceFile = vi.fn()

    render(
      <MessageList
        onOpenWorkspaceFile={onOpenWorkspaceFile}
        messages={[
          {
            id: 'codex-file-mention',
            role: 'user',
            content: [
              '# Files mentioned by the user:',
              '',
              '## package.json: /Users/dev/package.json',
              '',
              '## My request for Codex:',
              '看看',
            ].join('\n'),
            status: 'done',
            createdAt: '2026-05-25T15:08:00.000+08:00',
          },
        ]}
      />
    )

    expect(screen.getByTestId('message-codex-file-mention')).toHaveTextContent('package.json')
    expect(screen.getByTestId('message-codex-file-braces-icon')).toBeInTheDocument()
    expect(screen.queryByTestId('message-codex-file-document-icon')).not.toBeInTheDocument()
    expect(screen.getByTestId('message-codex-file-mention')).toHaveAttribute(
      'title',
      '/Users/dev/package.json'
    )
    expect(screen.getByTestId('user-message-content')).toHaveTextContent('看看')
    expect(screen.queryByText(/Files mentioned by the user/)).not.toBeInTheDocument()
    expect(screen.queryByText(/My request for Codex/)).not.toBeInTheDocument()

    fireEvent.click(screen.getByTestId('message-codex-file-mention'))
    expect(onOpenWorkspaceFile).toHaveBeenCalledWith('/Users/dev/package.json')
  })

  test('renders file-only Codex mentions without the raw markdown wrapper', () => {
    render(
      <MessageList
        messages={[
          {
            id: 'codex-file-only-mention',
            role: 'user',
            content: [
              '# Files mentioned by the user:',
              '',
              '## pnpm-lock.yaml: /Users/dev/pnpm-lock.yaml',
              '',
              '## My request for Codex:',
            ].join('\n'),
            status: 'done',
            createdAt: '2026-05-25T15:08:00.000+08:00',
          },
        ]}
      />
    )

    expect(screen.getByTestId('message-codex-file-mention')).toHaveTextContent('pnpm-lock.yaml')
    expect(screen.getByTestId('message-codex-file-document-icon')).toBeInTheDocument()
    expect(screen.queryByTestId('message-codex-file-braces-icon')).not.toBeInTheDocument()
    expect(screen.queryByTestId('user-message-content')).not.toBeInTheDocument()
    expect(screen.queryByText(/Files mentioned by the user/)).not.toBeInTheDocument()
    expect(screen.queryByText(/My request for Codex/)).not.toBeInTheDocument()
  })

  test('does not render raw local image paths when Tauri file conversion is unavailable', () => {
    tauriCoreMock.convertFileSrc.mockImplementation(() => {
      throw new Error('convertFileSrc unavailable')
    })

    render(
      <MessageList
        messages={[
          {
            id: 'browser-codex-image-mention',
            role: 'user',
            content: [
              '# Files mentioned by the user:',
              '',
              '## image.png: /Users/dev/.wegent-executor/workspace/attachments/10000000000001/0/image.png',
              '',
              '## My request for Codex:',
              '分析下这个图片',
            ].join('\n'),
            status: 'done',
            createdAt: '2026-05-25T15:08:00.000+08:00',
          },
        ]}
      />
    )

    expect(screen.queryByTestId('message-local-image-preview')).not.toBeInTheDocument()
    expect(screen.getByTestId('user-message-content')).toHaveTextContent('分析下这个图片')
  })

  test('hides Codex local image previews when the converted file URL fails to load', async () => {
    render(
      <MessageList
        messages={[
          {
            id: 'codex-image-mention-load-failure',
            role: 'user',
            content: [
              '# Files mentioned by the user:',
              '',
              '## image.png: /var/folders/tmp/codex-clipboard.png',
              '',
              '## My request for Codex:',
              '分析下这个图片',
            ].join('\n'),
            status: 'done',
            createdAt: '2026-05-25T15:08:00.000+08:00',
          },
        ]}
      />
    )

    fireEvent.error(await screen.findByTestId('message-local-image-preview'))

    expect(screen.queryByTestId('message-local-image-preview')).not.toBeInTheDocument()
    expect(screen.getByTestId('user-message-content')).toHaveTextContent('分析下这个图片')
  })

  test('does not create Tauri asset previews for transient Codex clipboard images', () => {
    render(
      <MessageList
        messages={[
          {
            id: 'codex-transient-clipboard-image',
            role: 'user',
            content: [
              '# Files mentioned by the user:',
              '',
              '## codex-clipboard-c73483f7-dfe5-413b-a30f-787bb2814c21.png: /var/folders/fp/l62gd0z17ys57j9s7t0dfq3w0000gn/T/codex-clipboard-c73483f7-dfe5-413b-a30f-787bb2814c21.png',
              '',
              '## My request for Codex:',
              '分析下这个图片',
            ].join('\n'),
            status: 'done',
            createdAt: '2026-05-25T15:08:00.000+08:00',
          },
        ]}
      />
    )

    expect(screen.queryByTestId('message-local-image-preview')).not.toBeInTheDocument()
    expect(screen.queryByTestId('message-codex-file-mention')).not.toBeInTheDocument()
    expect(tauriCoreMock.convertFileSrc).not.toHaveBeenCalledWith(
      expect.stringContaining('codex-clipboard-c73483f7')
    )
    expect(screen.getByTestId('user-message-content')).toHaveTextContent('分析下这个图片')
  })

  test('renders assistant markdown attachment images through authenticated blob previews', async () => {
    URL.createObjectURL = vi.fn(() => 'blob:assistant-markdown-image')
    URL.revokeObjectURL = vi.fn()
    localStorage.setItem('auth_token', 'token-1')
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        blob: vi.fn().mockResolvedValue(new Blob(['image'], { type: 'image/png' })),
      })
    )

    render(
      <MessageList
        messages={[
          {
            id: 'assistant-image',
            role: 'assistant',
            content: '生成结果：\n\n![diagram](/api/attachments/43/download)',
            status: 'done',
            createdAt: '2026-05-25T15:08:00.000+08:00',
          },
        ]}
      />
    )

    expect(await screen.findByTestId('assistant-markdown-image')).toHaveAttribute(
      'src',
      'blob:assistant-markdown-image'
    )
    expect(screen.getByTestId('assistant-markdown-image')).toHaveAttribute('alt', 'diagram')
    expect(fetch).toHaveBeenCalledWith(
      '/api/attachments/43/download',
      expect.objectContaining({
        headers: { Authorization: 'Bearer token-1' },
      })
    )
  })

  test('keeps an authenticated image failure stable when only the workspace loader changes', async () => {
    const fetchMock = vi.fn().mockRejectedValue(new Error('attachment unavailable'))
    vi.stubGlobal('fetch', fetchMock)
    const firstWorkspaceLoader = vi.fn()
    const nextWorkspaceLoader = vi.fn()
    const message = {
      id: 'assistant-authenticated-image-failure',
      role: 'assistant' as const,
      content: '![diagram](/api/attachments/43/download)',
      status: 'done' as const,
      createdAt: '2026-05-25T15:08:00.000+08:00',
    }
    const { rerender } = render(
      <WorkspaceMarkdownImageLoaderContext.Provider value={firstWorkspaceLoader}>
        <MessageList messages={[message]} />
      </WorkspaceMarkdownImageLoaderContext.Provider>
    )
    await screen.findByTestId('assistant-markdown-image-error')

    rerender(
      <WorkspaceMarkdownImageLoaderContext.Provider value={nextWorkspaceLoader}>
        <MessageList messages={[message]} />
      </WorkspaceMarkdownImageLoaderContext.Provider>
    )

    expect(screen.getByTestId('assistant-markdown-image-error')).toBeInTheDocument()
    expect(screen.queryByTestId('assistant-markdown-image-loading')).not.toBeInTheDocument()
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  test('renders assistant markdown local image paths through Tauri asset URLs', () => {
    render(
      <MessageList
        messages={[
          {
            id: 'assistant-local-image',
            role: 'assistant',
            content: '生成结果：\n\n![local result](/Users/dev/Pictures/result.png)',
            status: 'done',
            createdAt: '2026-05-25T15:08:00.000+08:00',
          },
        ]}
      />
    )

    expect(screen.getByTestId('assistant-markdown-image')).toHaveAttribute(
      'src',
      'asset://localhost/Users/dev/Pictures/result.png'
    )
    expect(screen.getByTestId('assistant-markdown-image')).toHaveAttribute('alt', 'local result')
  })

  test('downloads assistant local Markdown images in Gateway Web without native invoke', async () => {
    tauriCoreMock.isTauri.mockReturnValue(true)
    tauriCoreMock.convertFileSrc.mockImplementation(() => {
      throw new Error('Gateway Web has no native convertFileSrc')
    })
    ;(window as typeof window & { __KCODER_GATEWAY_WEB_SHIM__?: boolean })
      .__KCODER_GATEWAY_WEB_SHIM__ = true
    URL.createObjectURL = vi.fn(() => 'blob:gateway-markdown-image')
    URL.revokeObjectURL = vi.fn()
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        blob: vi.fn().mockResolvedValue(new Blob(['image'], { type: 'image/png' })),
      })
    )

    const loadWorkspaceImage = vi
      .fn()
      .mockResolvedValue(new Blob(['workspace-image'], { type: 'image/png' }))
    render(
      <WorkspaceMarkdownImageLoaderContext.Provider value={loadWorkspaceImage}>
        <MessageList
          messages={[
            {
              id: 'assistant-gateway-local-image',
              role: 'assistant',
              content: '![local result](result.png)',
              status: 'done',
              createdAt: '2026-05-25T15:08:00.000+08:00',
            },
          ]}
        />
      </WorkspaceMarkdownImageLoaderContext.Provider>
    )

    await userEvent.click(await screen.findByTestId('assistant-markdown-image-button'))
    await userEvent.click(screen.getByTestId('attachment-image-download'))

    await waitFor(() => expect(URL.createObjectURL).toHaveBeenCalled())
    expect(loadWorkspaceImage).toHaveBeenCalledWith('result.png')
    expect(tauriCoreMock.invoke).not.toHaveBeenCalled()
    expect(fetch).not.toHaveBeenCalled()
  })

  test('retries the same workspace image path when the active task loader changes', async () => {
    tauriCoreMock.isTauri.mockReturnValue(true)
    tauriCoreMock.convertFileSrc.mockImplementation(() => {
      throw new Error('Gateway Web has no native convertFileSrc')
    })
    ;(window as typeof window & { __KCODER_GATEWAY_WEB_SHIM__?: boolean })
      .__KCODER_GATEWAY_WEB_SHIM__ = true
    URL.createObjectURL = vi.fn(() => 'blob:recovered-workspace-image')
    URL.revokeObjectURL = vi.fn()
    const failedLoader = vi.fn().mockRejectedValue(new Error('task is temporarily unavailable'))
    const recoveredLoader = vi.fn().mockResolvedValue(new Blob(['image'], { type: 'image/png' }))
    const message = {
      id: 'assistant-retried-workspace-image',
      role: 'assistant' as const,
      content: '![result](result.png)',
      status: 'done' as const,
      createdAt: '2026-05-25T15:08:00.000+08:00',
    }
    const { rerender } = render(
      <WorkspaceMarkdownImageLoaderContext.Provider value={failedLoader}>
        <MessageList messages={[message]} />
      </WorkspaceMarkdownImageLoaderContext.Provider>
    )
    await screen.findByTestId('assistant-markdown-image-error')

    rerender(
      <WorkspaceMarkdownImageLoaderContext.Provider value={recoveredLoader}>
        <MessageList messages={[message]} />
      </WorkspaceMarkdownImageLoaderContext.Provider>
    )

    expect(await screen.findByTestId('assistant-markdown-image-button')).toBeInTheDocument()
    expect(screen.queryByTestId('assistant-markdown-image-error')).not.toBeInTheDocument()
    expect(recoveredLoader).toHaveBeenCalledWith('result.png')
  })

  test('opens an enlarged preview from a user message image attachment', async () => {
    URL.createObjectURL = vi.fn(() => 'blob:message-image-preview')
    URL.revokeObjectURL = vi.fn()
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        blob: vi.fn().mockResolvedValue(new Blob(['image'], { type: 'image/png' })),
      })
    )

    const attachment: Attachment = {
      id: 43,
      filename: 'diagram.png',
      file_size: 1024,
      mime_type: 'image/png',
      status: 'ready',
      file_extension: '.png',
      created_at: '2026-05-25T15:08:00.000+08:00',
    }

    render(
      <MessageList
        messages={[
          {
            id: '1',
            role: 'user',
            content: '分析下这个图片',
            status: 'done',
            attachments: [attachment],
            createdAt: '2026-05-25T15:08:00.000+08:00',
          },
        ]}
      />
    )

    await userEvent.click(await screen.findByTestId('message-image-preview'))

    const lightbox = screen.getByTestId('attachment-image-lightbox')
    const lightboxImage = await screen.findByTestId('attachment-image-lightbox-image')

    expect(lightbox).toBeInTheDocument()
    expect(lightbox.parentElement).toBe(document.body)
    expect(lightboxImage).toHaveAttribute('src', 'blob:message-image-preview')
    expect(lightboxImage).toHaveAttribute('alt', 'diagram.png')
    expect(lightboxImage).toHaveStyle({ transform: 'scale(1)' })
    expect(screen.getByTestId('attachment-image-download')).toBeEnabled()
    expect(screen.getByTestId('attachment-image-zoom-controls')).toHaveClass('bottom-6')
    expect(screen.getByTestId('attachment-image-zoom-value')).toHaveTextContent('100%')

    await userEvent.click(screen.getByTestId('attachment-image-zoom-in'))

    expect(lightboxImage).toHaveStyle({ transform: 'scale(1.25)' })
    expect(screen.getByTestId('attachment-image-zoom-value')).toHaveTextContent('125%')
  })

  test('navigates between images in the enlarged preview gallery', async () => {
    vi.stubGlobal('fetch', vi.fn())

    const attachments: Attachment[] = [
      {
        id: 43,
        filename: 'first.png',
        file_size: 1024,
        mime_type: 'image/png',
        status: 'ready',
        file_extension: '.png',
        created_at: '2026-05-25T15:08:00.000+08:00',
        local_preview_url: 'blob:first-image',
      },
      {
        id: 44,
        filename: 'second.png',
        file_size: 1024,
        mime_type: 'image/png',
        status: 'ready',
        file_extension: '.png',
        created_at: '2026-05-25T15:08:00.000+08:00',
        local_preview_url: 'blob:second-image',
      },
    ]

    render(
      <MessageList
        messages={[
          {
            id: '1',
            role: 'user',
            content: '分析下这些图片',
            status: 'done',
            attachments,
            createdAt: '2026-05-25T15:08:00.000+08:00',
          },
        ]}
      />
    )

    const previews = await screen.findAllByTestId('message-image-preview')
    await userEvent.click(previews[0])

    expect(await screen.findByTestId('attachment-image-lightbox-image')).toHaveAttribute(
      'alt',
      'first.png'
    )

    await userEvent.click(screen.getByTestId('attachment-image-next'))

    await waitFor(() => {
      expect(screen.getByTestId('attachment-image-lightbox-image')).toHaveAttribute(
        'src',
        'blob:second-image'
      )
      expect(screen.getByTestId('attachment-image-lightbox-image')).toHaveAttribute(
        'alt',
        'second.png'
      )
    })

    await userEvent.click(screen.getByTestId('attachment-image-previous'))

    await waitFor(() => {
      expect(screen.getByTestId('attachment-image-lightbox-image')).toHaveAttribute(
        'src',
        'blob:first-image'
      )
      expect(screen.getByTestId('attachment-image-lightbox-image')).toHaveAttribute(
        'alt',
        'first.png'
      )
    })
  })

  test('keeps image attachments in a single horizontal strip', async () => {
    URL.createObjectURL = vi.fn(() => 'blob:message-image-preview')
    URL.revokeObjectURL = vi.fn()
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        blob: vi.fn().mockResolvedValue(new Blob(['image'], { type: 'image/png' })),
      })
    )

    const attachments: Attachment[] = [
      {
        id: 43,
        filename: 'first.png',
        file_size: 1024,
        mime_type: 'image/png',
        status: 'ready',
        file_extension: '.png',
        created_at: '2026-05-25T15:08:00.000+08:00',
      },
      {
        id: 44,
        filename: 'second.png',
        file_size: 1024,
        mime_type: 'image/png',
        status: 'ready',
        file_extension: '.png',
        created_at: '2026-05-25T15:08:00.000+08:00',
      },
      {
        id: 45,
        filename: 'third.png',
        file_size: 1024,
        mime_type: 'image/png',
        status: 'ready',
        file_extension: '.png',
        created_at: '2026-05-25T15:08:00.000+08:00',
      },
      {
        id: 46,
        filename: 'fourth.png',
        file_size: 1024,
        mime_type: 'image/png',
        status: 'ready',
        file_extension: '.png',
        created_at: '2026-05-25T15:08:00.000+08:00',
      },
    ]

    render(
      <MessageList
        messages={[
          {
            id: '1',
            role: 'user',
            content: '',
            status: 'done',
            attachments,
            createdAt: '2026-05-25T15:08:00.000+08:00',
          },
        ]}
      />
    )

    const previews = await screen.findAllByTestId('message-image-preview')

    expect(previews).toHaveLength(4)
    expect(screen.getByTestId('message-image-attachments')).toHaveClass(
      'w-full',
      'flex-row',
      'flex-nowrap',
      'overflow-x-auto',
      'scrollbar-none'
    )
    expect(screen.getByTestId('message-image-attachment-strip')).toHaveClass(
      'ml-auto',
      'w-max',
      'flex-nowrap',
      'justify-end'
    )
    expect(screen.getByTestId('message-image-attachments')).not.toHaveClass('justify-start')
    expect(screen.getByTestId('message-image-attachments')).not.toHaveClass('flex-wrap')
    expect(screen.getByTestId('message-hover-region')).toHaveClass('w-full', 'max-w-full')
    expect(previews[0]).toHaveClass('h-20', 'w-20', 'shrink-0', 'rounded-xl', 'object-cover')
  })

  test('renders document attachments in user messages', () => {
    const attachment: Attachment = {
      id: 44,
      filename: 'requirements.pdf',
      file_size: 2048,
      mime_type: 'application/pdf',
      status: 'ready',
      file_extension: '.pdf',
      created_at: '2026-05-25T15:09:00.000+08:00',
    }

    render(
      <MessageList
        messages={[
          {
            id: '1',
            role: 'user',
            content: '分析下文档',
            status: 'done',
            attachments: [attachment],
            createdAt: '2026-05-25T15:09:00.000+08:00',
          },
        ]}
      />
    )

    expect(screen.getByTestId('message-document-attachment')).toHaveTextContent('requirements.pdf')
    expect(screen.getByTestId('message-document-attachment')).toHaveTextContent('PDF')
  })

  test('renders text attachments in user messages as compact clickable preview chips', async () => {
    const onOpenWorkspaceFile = vi.fn()
    const attachment: Attachment = {
      id: 45,
      filename: 'clipboard-text-1783070360990.txt',
      file_size: 2048,
      mime_type: 'text/plain',
      status: 'ready',
      file_extension: '.txt',
      created_at: '2026-05-25T15:09:00.000+08:00',
      text_preview: '{ "event_type": "http_exchange", "id": "e9972aac" }',
      local_path:
        '/Users/me/.wegent-executor/workspace/attachments/draft/-45/clipboard-text-1783070360990.txt',
    }

    render(
      <MessageList
        messages={[
          {
            id: '1',
            role: 'user',
            content: '',
            status: 'done',
            attachments: [attachment],
            createdAt: '2026-05-25T15:09:00.000+08:00',
          },
        ]}
        onOpenWorkspaceFile={onOpenWorkspaceFile}
      />
    )

    expect(screen.getByTestId('message-text-attachment')).toHaveClass('h-9', 'rounded-full')
    expect(screen.getByTestId('message-text-attachment')).toHaveAttribute('type', 'button')
    expect(screen.getByTestId('message-text-attachment-icon')).not.toHaveAttribute(
      'data-testid',
      'message-codex-file-braces-icon'
    )
    expect(screen.getByTestId('message-text-attachment-preview')).toHaveTextContent(
      '{ "event_type": "http_exchange", "id": "e9972aac" }'
    )
    expect(screen.queryByTestId('message-document-attachment')).not.toBeInTheDocument()

    await userEvent.click(screen.getByTestId('message-text-attachment'))

    await waitFor(() =>
      expect(onOpenWorkspaceFile).toHaveBeenCalledWith(
        '/Users/me/.wegent-executor/workspace/attachments/draft/-45/clipboard-text-1783070360990.txt'
      )
    )
  })
})
