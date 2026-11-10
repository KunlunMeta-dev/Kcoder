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
