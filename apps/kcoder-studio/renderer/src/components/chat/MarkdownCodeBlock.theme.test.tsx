import { act, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, test } from 'vitest'
import { MarkdownCodeBlock } from './MarkdownCodeBlock'

describe('MarkdownCodeBlock 主题', () => {
  afterEach(() => {
    document.documentElement.removeAttribute('data-theme')
    document.documentElement.classList.remove('dark')
  })

  test('跟随应用的 light/dark 主题切换语法高亮配色', async () => {
    document.documentElement.dataset.theme = 'light'
    render(<MarkdownCodeBlock lang="typescript">const answer = 42</MarkdownCodeBlock>)

    expect(screen.getByTestId('markdown-code-block')).toHaveAttribute('data-color-scheme', 'light')

    await act(async () => {
      document.documentElement.dataset.theme = 'dark'
      await Promise.resolve()
    })

    expect(screen.getByTestId('markdown-code-block')).toHaveAttribute('data-color-scheme', 'dark')
  })
})
