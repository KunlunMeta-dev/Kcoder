import { render, waitFor } from '@testing-library/react'
import { describe, expect, test } from 'vitest'
import { AssistantMarkdown } from './AssistantMarkdown'

describe('AssistantMarkdown 数学公式', () => {
  test('使用 KaTeX 渲染行内和块级 LaTeX，而不是显示美元分隔符', () => {
    const { container } = render(
      <AssistantMarkdown
        content={
          '倍角公式 $\\sin 2x = 2\\sin x\\cos x$\n\n$$\\boxed{\\sin 3x = 3\\sin x - 4\\sin^3 x}$$'
        }
      />
    )

    expect(container.querySelectorAll('.katex')).toHaveLength(2)
    expect(container.textContent).not.toContain('$$')
    expect(container.textContent).not.toContain('$\\sin')
  })

  test('保留标准多行块公式的 display 布局', () => {
    const { container } = render(
      <AssistantMarkdown content={'推导结果：\n\n$$\n\\sin 3x = 3\\sin x - 4\\sin^3 x\n$$'} />
    )

    expect(container.querySelector('.katex-display')).not.toBeNull()
  })

  test('兼容括号分隔符与 fenced latex', () => {
    const { container } = render(
      <AssistantMarkdown
        content={'行内 \\(E=mc^2\\)\n\n\\[\n\\int_0^1 x^2\\,dx\n\\]\n\n```latex\n\\frac{1}{2}\n```'}
      />
    )

    expect(container.querySelectorAll('.katex')).toHaveLength(3)
    expect(container.querySelectorAll('.katex-display')).toHaveLength(2)
    expect(container.querySelector('[data-testid="markdown-code-block"]')).toBeNull()
  })

  test('流式接收未闭合的括号公式时不崩溃，闭合后转为公式', async () => {
    const { container, rerender } = render(
      <AssistantMarkdown content={String.raw`正在计算 \(x^`} isStreaming />
    )

    expect(container.textContent).toContain('正在计算')

    rerender(<AssistantMarkdown content={String.raw`正在计算 \(x^2\)`} isStreaming />)
    await waitFor(() => expect(container.querySelector('.katex')).not.toBeNull())
  })
})
