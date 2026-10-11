import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { AssistantMarkdown } from './AssistantMarkdown'
import { MarkdownMermaidBlock } from './MarkdownMermaidBlock'

describe('AssistantMarkdown 富内容', () => {
  beforeEach(() => {
    vi.stubGlobal(
      'IntersectionObserver',
      class {
        constructor(private readonly callback: IntersectionObserverCallback) {}
        observe(element: Element) {
          this.callback(
            [
              {
                isIntersecting: true,
                intersectionRatio: 1,
                target: element,
              } as IntersectionObserverEntry,
            ],
            this as unknown as IntersectionObserver
          )
        }
        disconnect() {}
        unobserve() {}
        takeRecords() {
          return []
        }
      }
    )
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
  })

  test('渲染 CJK 标点边界处的强调', () => {
    render(<AssistantMarkdown content="**重要提示（请注意）：**后续操作不可撤销。" />)

    expect(screen.getByText('重要提示（请注意）：', { selector: 'strong' })).toBeInTheDocument()
  })

  test('keeps existing Markdown DOM mounted when a fast stream crosses the window threshold', async () => {
    vi.stubGlobal('__TAURI_INTERNALS__', {})
    const prefix = `# Stable heading\n\n${'alpha '.repeat(260)}\n\n# Next heading\n\n`
    const { rerender } = render(<AssistantMarkdown content={prefix} isStreaming />)
    const heading = screen.getByRole('heading', { name: 'Stable heading' })
    rerender(<AssistantMarkdown content={`${prefix}${'beta '.repeat(700)}`} isStreaming />)
    await waitFor(() => expect(screen.getByText(/beta beta/)).toBeInTheDocument())
    expect(screen.getByRole('heading', { name: 'Stable heading' })).toBe(heading)
  })

  test('keeps all paragraph DOM available when chunks leave the viewport', () => {
    vi.stubGlobal('__TAURI_INTERNALS__', {})
    const observers: Array<() => void> = []
    vi.stubGlobal(
      'IntersectionObserver',
      class {
        constructor(private callback: IntersectionObserverCallback) {}
        observe(target: Element) {
          observers.push(() =>
            this.callback(
              [{ isIntersecting: false, target } as IntersectionObserverEntry],
              this as unknown as IntersectionObserver
            )
          )
        }
        disconnect() {}
      }
    )
    const content = Array.from(
      { length: 4 },
      (_, index) => `## Retained section ${index}\n\n${'Readable paragraph. '.repeat(90)}\n\n`
    ).join('')
    const { container } = render(<AssistantMarkdown content={content} />)
    expect(screen.getAllByRole('heading')).toHaveLength(4)
    const middle = screen.getByRole('heading', { name: 'Retained section 1' })
    act(() => observers.forEach(notify => notify()))
    expect(screen.getByRole('heading', { name: 'Retained section 1' })).toBe(middle)
    for (const chunk of container.querySelectorAll<HTMLElement>('[data-markdown-window-chunk]')) {
      expect(chunk.childElementCount).toBeGreaterThan(0)
      expect(chunk.style.minHeight).toBe('')
    }
  })

  test('把合法 Mermaid 代码块渲染为图表', async () => {
    const { container } = render(
      <AssistantMarkdown content={'```mermaid\ngraph TD\n  A[开始] --> B[结束]\n```'} />
    )

    await waitFor(() => {
      expect(container.querySelector('[data-streamdown="mermaid"] svg')).not.toBeNull()
    })
    expect(container.textContent).not.toContain('graph TD')
  })

  test('非法 Mermaid 保留可读源码而不是令消息崩溃', async () => {
    render(<AssistantMarkdown content={'```mermaid\ngraph TD\n  A[未闭合 -->\n```'} />)

    const fallback = await screen.findByTestId('markdown-mermaid-error')
    expect(fallback).toHaveTextContent('graph TD')
    expect(fallback).toHaveTextContent('A[未闭合')
  })

  test('流式 Mermaid 从不完整源码变为合法源码后会重新渲染', async () => {
    const { container, rerender } = render(
      <MarkdownMermaidBlock chart={'graph TD\n  A[未闭合 -->'} />
    )
    await screen.findByTestId('markdown-mermaid-error')

    rerender(<MarkdownMermaidBlock chart={'graph TD\n  A[开始] --> B[结束]'} />)

    await waitFor(() => {
      expect(container.querySelector('[data-streamdown="mermaid"] svg')).not.toBeNull()
    })
    expect(screen.queryByTestId('markdown-mermaid-error')).toBeNull()
  })

  test('正文图片可通过键盘打开可访问灯箱并在请求失败时回退下载', async () => {
    const user = userEvent.setup()
    const fetchMock = vi.fn().mockRejectedValue(new TypeError('Failed to fetch'))
    vi.stubGlobal('fetch', fetchMock)
    const clickSpy = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {})
    render(<AssistantMarkdown content="![架构图](https://example.com/architecture.png)" />)

    const imageButton = await screen.findByTestId('assistant-markdown-image-button')
    expect(imageButton).toHaveAccessibleName('架构图')
    imageButton.focus()
    await user.keyboard('{Enter}')

    const dialog = await screen.findByTestId('attachment-image-lightbox')
    expect(dialog).toHaveAttribute('role', 'dialog')
    expect(screen.getByTestId('attachment-image-lightbox-image')).toHaveAttribute(
      'src',
      'https://example.com/architecture.png'
    )
    expect(screen.getByTestId('attachment-image-lightbox-close')).toHaveFocus()

    fireEvent.click(screen.getByTestId('attachment-image-download'))
    await waitFor(() => expect(clickSpy).toHaveBeenCalled())
    expect(fetchMock).toHaveBeenCalledWith('https://example.com/architecture.png')
    const downloadLink = clickSpy.mock.instances[0] as HTMLAnchorElement
    expect(downloadLink.href).toBe('https://example.com/architecture.png')
    expect(downloadLink.download).not.toBe('')

    fireEvent.keyDown(window, { key: 'Escape' })
    await waitFor(() => expect(screen.queryByTestId('attachment-image-lightbox')).toBeNull())
  })

  test('外域伪造的附件路径绝不会携带本地访问令牌', async () => {
    localStorage.setItem('auth_token', 'private-token')
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)

    render(
      <AssistantMarkdown content="![恶意图片](https://attacker.example/api/attachments/43/download)" />
    )

    expect(await screen.findByTestId('assistant-markdown-image')).toHaveAttribute(
      'src',
      'https://attacker.example/api/attachments/43/download'
    )
    expect(fetchMock).not.toHaveBeenCalled()
  })

  test('相同正文重新渲染后使用最新的文件打开回调', async () => {
    const user = userEvent.setup()
    const firstOpen = vi.fn()
    const latestOpen = vi.fn()
    const content = '[打开配置](/workspace/project/config.json)'
    const { rerender } = render(<AssistantMarkdown content={content} onOpenFile={firstOpen} />)

    rerender(<AssistantMarkdown content={content} onOpenFile={latestOpen} />)
    await user.click(screen.getByTestId('assistant-markdown-link'))

    expect(firstOpen).not.toHaveBeenCalled()
    expect(latestOpen).toHaveBeenCalledWith('/workspace/project/config.json')
  })
})
