import { render, screen } from '@testing-library/react'
import { expect, test, vi } from 'vitest'
import { AssistantMarkdown } from './AssistantMarkdown'
import i18n from '@/i18n'

const failure = vi.hoisted(() => ({ attempts: vi.fn() }))
vi.mock('./markdownMathPlugin', () => { failure.attempts(); throw new Error('Controlled math plugin failure') })

test.each(['zh-CN', 'en'])('a failed formula module preserves prose and source without repeated streaming loads (%s)', async locale => {
  await i18n.changeLanguage(locale)
  const view = render(<AssistantMarkdown content={'Other text remains usable.\n\n$x^2$'} />)
  expect(await screen.findByTestId('markdown-math-unavailable')).toHaveTextContent(locale === 'en' ? 'source text is preserved' : '已保留原文')
  expect(screen.getByText('Other text remains usable.')).toBeInTheDocument()
  expect(view.container).toHaveTextContent('$x^2$')
  expect(view.container.querySelector('.katex')).toBeNull()
  const attempts = failure.attempts.mock.calls.length
  view.rerender(<AssistantMarkdown content={'Other text remains usable.\n\n$x^3$'} />)
  expect(view.container).toHaveTextContent('$x^3$')
  expect(failure.attempts).toHaveBeenCalledTimes(attempts)
  await i18n.changeLanguage('zh-CN')
})
