import '@/i18n'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { expect, it, vi } from 'vitest'
import { RequestUserInputCard } from './RequestUserInputCard'

for (const id of ['__proto__', 'constructor', 'toString', 'hasOwnProperty']) {
  it.each(['single', 'multiple', 'text'] as const)(
    `answers a %s question whose item ID is ${id} without reading inherited state`,
    async mode => {
      const user = userEvent.setup()
      const onSubmit = vi.fn()
      const item = (itemId: string) => ({
        id: itemId, question: `Question ${itemId}`, multiSelect: mode === 'multiple',
        options: mode === 'text' ? [] : [{ id: 'chosen', label: 'Choose this' }],
      })
      render(<RequestUserInputCard
        payload={{ requestId: 42, itemId: 'original-question', questions: [item('ordinary'), item(id)] }}
        selectionValue="id"
        autoSubmitOnOptionSelect={false}
        preselectFirstOption={false}
        focusOnMount={false}
        requireAnswer
        allowImplementationPlanShortcut={false}
        onSubmit={onSubmit}
      />)
      const submit = screen.getByTestId('request-user-input-submit-button')
      expect(submit).toBeDisabled()
      // Updating another entry must also keep the special ID unanswered.
      for (const itemId of ['ordinary', id]) {
        if (mode === 'text')
          await user.type(screen.getByTestId(`request-user-input-custom-${itemId}`), 'Exact text')
        else
          await user.click(screen.getByTestId(`request-user-input-option-${itemId}-0`))
        if (itemId === 'ordinary') expect(submit).toBeDisabled()
      }
      await user.click(submit)
      expect(onSubmit).toHaveBeenCalledTimes(1)
      const [response, values] = onSubmit.mock.calls[0]
      expect(Object.hasOwn(response.answers, id)).toBe(true)
      expect(response.answers[id]).toEqual({ answers: [mode === 'text' ? 'Exact text' : 'chosen'] })
      expect(Object.hasOwn(values, id)).toBe(true)
      expect(JSON.parse(JSON.stringify(values))[id]).toEqual(mode === 'text'
        ? { selectedOptionIds: [], text: 'Exact text' }
        : { selectedOptionIds: ['chosen'] })
    }
  )
}
