import '@/i18n'
import { fireEvent, render, screen } from '@testing-library/react'
import { expect, test, vi } from 'vitest'
import { RequestUserInputCard } from './RequestUserInputCard'

test.each(['\uFEFF', '\uFEFF原题\uFEFF', '  保留原题缩进\n'])('preserves the original nonblank prompt %j', prompt => {
  const submit = vi.fn()
  const { container } = render(<RequestUserInputCard
    payload={{ requestId: 91, threadId: 'thread', turnId: 'turn', questions: [{
      id: 'original-item', question: prompt, options: [],
    }] }}
    requireAnswer onSubmit={submit}
  />)
  expect(container.querySelector('.font-semibold')?.textContent).toBe(prompt)
  fireEvent.change(screen.getByTestId('request-user-input-custom-original-item'), {
    target: { value: 'Answer to the original prompt' },
  })
  fireEvent.click(screen.getByTestId('request-user-input-submit-button'))
  expect(submit).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({
    threadId: 'thread', turnId: 'turn',
    answers: { 'original-item': { answers: ['Answer to the original prompt'] } },
  }))
})

test('uses the legacy item fallback for a Rust-whitespace-only prompt', () => {
  const { container } = render(<RequestUserInputCard payload={{ questions: [{
    id: 'legacy-item', question: '\u0085', options: [],
  }] }} />)
  expect(container.querySelector('.font-semibold')?.textContent).toBe('legacy-item')
})
