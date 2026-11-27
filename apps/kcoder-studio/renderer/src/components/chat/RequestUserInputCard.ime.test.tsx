import '@/i18n'
import { fireEvent, render, screen } from '@testing-library/react'
import { expect, test, vi } from 'vitest'
import { RequestUserInputCard } from './RequestUserInputCard'

for (const ime of [{ isComposing: true }, { keyCode: 229 }]) {
  test(`IME keys preserve the answer card and draft (${JSON.stringify(ime)})`, () => {
    const ignore = vi.fn(), submit = vi.fn(), parentKeyDown = vi.fn()
    render(<div onKeyDown={parentKeyDown}>
      <RequestUserInputCard
        payload={{ questions: [{ id: 'details', question: '补充说明？', options: [] }] }}
        selectionValue="id"
        autoSubmitOnOptionSelect={false}
        preselectFirstOption={false}
        allowImplementationPlanShortcut={false}
        requireAnswer
        onIgnore={ignore}
        onSubmit={submit}
      />
    </div>)
    const draft = screen.getByTestId('request-user-input-custom-details')
    fireEvent.change(draft, { target: { value: '保留原任务草稿' } })
    fireEvent.keyDown(draft, { key: 'Enter', ...ime })
    expect(submit).not.toHaveBeenCalled()
    parentKeyDown.mockClear()
    const escape = new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true, ...ime })
    fireEvent(draft, escape)
    expect(ignore).not.toHaveBeenCalled()
    expect(parentKeyDown).not.toHaveBeenCalled()
    expect(escape.defaultPrevented).toBe(false)
    expect(draft).toHaveValue('保留原任务草稿')
    fireEvent.keyDown(draft, { key: 'Escape' })
    expect(ignore).toHaveBeenCalledTimes(1)
    fireEvent.keyDown(draft, { key: 'Enter' })
    expect(submit).toHaveBeenCalledExactlyOnceWith(expect.anything(), {
      details: { selectedOptionIds: [], text: '保留原任务草稿' },
    })
  })
}

for (const ime of [{ isComposing: true }, { keyCode: 229 }]) {
  test.each(['recovery', 'submission'])(
    `IME candidate cancellation stays inside a locked card (%s, ${JSON.stringify(ime)})`,
    lock => {
      const ignore = vi.fn(), parentKeyDown = vi.fn()
      const submit = vi.fn(() => new Promise<boolean>(() => undefined))
      const payload = { threadId: 'original-thread', requestId: 42,
        questions: [{ id: 'details', question: '补充说明？', options: [] }] }
      const card = (disabled = false) => <div onKeyDown={parentKeyDown}>
        <RequestUserInputCard payload={payload} embedded disabled={disabled}
          selectionValue="id" autoSubmitOnOptionSelect={false} preselectFirstOption={false}
          allowImplementationPlanShortcut={false} requireAnswer onIgnore={ignore} onSubmit={submit} />
      </div>
      const view = render(card())
      const draft = screen.getByTestId('request-user-input-custom-details')
      fireEvent.change(draft, { target: { value: '保留原任务草稿' } })
      if (lock === 'recovery') view.rerender(card(true))
      else fireEvent.click(screen.getByTestId('request-user-input-submit-button'))
      expect(screen.getByTestId('request-user-input-submit-button')).toBeDisabled()
      // A composition key may already be queued when recovery locks the input.
      const escape = new KeyboardEvent('keydown', {
        key: 'Escape', bubbles: true, cancelable: true, ...ime,
      })
      fireEvent(draft, escape)
      fireEvent.keyDown(draft, { key: 'Enter', ...ime })
      expect.soft(parentKeyDown.mock.calls.filter(([event]) => event.key === 'Escape')).toHaveLength(0)
      expect(ignore).not.toHaveBeenCalled()
      expect(escape.defaultPrevented).toBe(false)
      expect(draft).toHaveValue('保留原任务草稿')
      expect(submit).toHaveBeenCalledTimes(lock === 'submission' ? 1 : 0)
      expect(screen.getByTestId('request-user-input-submit-button')).toBeDisabled()
    },
  )
}
