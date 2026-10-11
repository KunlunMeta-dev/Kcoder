import { fireEvent, render, screen } from '@testing-library/react'
import { expect, test, vi } from 'vitest'
import { ModalDialog } from './modal-dialog'

test('focus containment skips closed disclosure contents and restores the opener', () => {
  const opener = document.createElement('button')
  document.body.append(opener)
  opener.focus()
  const { unmount } = render(
    <ModalDialog title="Settings" testId="settings" onClose={vi.fn()}>
      <details>
        <summary>Advanced settings</summary>
        <button>Hidden action</button>
        <details open>
          <summary>Nested settings</summary>
          <button>Nested action</button>
        </details>
      </details>
      <button>Done</button>
    </ModalDialog>
  )
  const summary = screen.getByText('Advanced settings')
  const done = screen.getByText('Done')
  expect(summary).toHaveFocus()
  fireEvent.keyDown(summary, { key: 'Tab', shiftKey: true })
  expect(done).toHaveFocus()
  fireEvent.keyDown(done, { key: 'Tab' })
  expect(summary).toHaveFocus()
  summary.parentElement!.setAttribute('open', '')
  const nested = screen.getByText('Nested action')
  done.hidden = true
  nested.focus()
  fireEvent.keyDown(nested, { key: 'Tab' })
  expect(summary).toHaveFocus()
  unmount()
  expect(opener).toHaveFocus()
  opener.remove()
})
