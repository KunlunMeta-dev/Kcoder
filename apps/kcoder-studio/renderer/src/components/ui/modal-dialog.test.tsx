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

test('a hidden modal retains its form and cannot consume another modal Escape', () => {
  const oldClose = vi.fn(), newClose = vi.fn()
  const view = render(<>
    <ModalDialog title="Old" testId="old" onClose={oldClose}>
      <input aria-label="old note" />
    </ModalDialog>
  </>)
  const input = screen.getByRole('textbox', { name: 'old note' })
  fireEvent.change(input, { target: { value: 'retained draft' } })
  view.rerender(<>
    <ModalDialog title="Old" testId="old" onClose={oldClose} hidden>
      <input aria-label="old note" />
    </ModalDialog>
    <ModalDialog title="New" testId="new" onClose={newClose}>
      <button>New action</button>
    </ModalDialog>
  </>)
  expect(screen.getByTestId('old')).not.toBeVisible()
  expect(screen.queryByRole('textbox', { name: 'old note' })).not.toBeInTheDocument()
  expect(input).toHaveValue('retained draft')
  expect(screen.getByRole('button', { name: 'New action' })).toHaveFocus()
  fireEvent.keyDown(document, { key: 'Escape' })
  expect(oldClose).not.toHaveBeenCalled()
  expect(newClose).toHaveBeenCalledOnce()
  view.unmount()
})
