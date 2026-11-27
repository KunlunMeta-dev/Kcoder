import { fireEvent, render, screen } from '@testing-library/react'
import { expect, test, vi } from 'vitest'
import { RetainedPage } from '@/components/layout/retainedPages'
import { ModalDialog } from './modal-dialog'

test('a hidden retained dialog cannot take focus or consume another page Escape key', () => {
  const close = vi.fn()
  const opener = document.createElement('button')
  document.body.append(opener)
  opener.focus()
  const view = render(
    <RetainedPage open={false}>
      <ModalDialog title="Original task" testId="retained-dialog" onClose={close}>
        <button>Original task action</button>
      </ModalDialog>
    </RetainedPage>
  )
  expect(opener).toHaveFocus()
  expect(screen.getByTestId('retained-dialog')).not.toBeVisible()
  fireEvent.keyDown(opener, { key: 'Escape' })
  expect(close).not.toHaveBeenCalled()
  view.unmount()
  opener.remove()
})

test('leaving a retained dialog releases Escape while returning keeps the original form', () => {
  const close = vi.fn()
  function Dialog({ open }: { open: boolean }) {
    return <RetainedPage open={open}>
      <ModalDialog title="Original task" testId="retained-dialog" onClose={close}>
        <input aria-label="Original task note" />
      </ModalDialog>
    </RetainedPage>
  }
  const view = render(<Dialog open />)
  const note = screen.getByRole('textbox')
  fireEvent.change(note, { target: { value: 'Original note' } })
  view.rerender(<Dialog open={false} />)
  const event = new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })
  document.dispatchEvent(event)
  expect(event.defaultPrevented).toBe(false)
  expect(close).not.toHaveBeenCalled()
  view.rerender(<Dialog open />)
  expect(note).toHaveValue('Original note')
  fireEvent.keyDown(note, { key: 'Escape' })
  expect(close).toHaveBeenCalledOnce()
})
