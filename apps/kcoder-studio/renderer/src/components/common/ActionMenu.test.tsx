import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { expect, test, vi } from 'vitest'
import { MoreHorizontal } from 'lucide-react'
import { ActionMenu } from './ActionMenu'
import { ModalDialog } from '@/components/ui/modal-dialog'

function fixture(placement?: 'bottom-end') {
  const first = vi.fn()
  const second = vi.fn()
  const menu = (
    <ActionMenu
      ariaLabel="Owned actions"
      testId="owned-actions"
      placement={placement}
      items={[
        {
          label: 'Unavailable',
          icon: MoreHorizontal,
          testId: 'unavailable',
          onSelect: vi.fn(),
          disabled: true,
        },
        { label: 'First', icon: MoreHorizontal, testId: 'first-action', onSelect: first },
        { label: 'Second', icon: MoreHorizontal, testId: 'second-action', onSelect: second },
      ]}
    />
  )
  return { first, second, menu }
}

test('a pointer selection does not consume the next keyboard click', async () => {
  const data = fixture()
  render(data.menu)
  fireEvent.click(screen.getByTestId('owned-actions'))
  fireEvent.pointerDown(screen.getByTestId('first-action'))
  await waitFor(() => expect(screen.queryByRole('menu')).not.toBeInTheDocument())
  expect(data.first).toHaveBeenCalledTimes(1)
  fireEvent.click(screen.getByTestId('owned-actions'))
  fireEvent.click(screen.getByTestId('second-action'), { detail: 0 })
  expect(data.second).toHaveBeenCalledTimes(1)
})

test('the menu focuses enabled items, supports Home/End and returns focus on Escape', async () => {
  render(fixture().menu)
  const trigger = screen.getByTestId('owned-actions')
  fireEvent.click(trigger)
  await waitFor(() => expect(screen.getByTestId('first-action')).toHaveFocus())
  expect(screen.getByTestId('first-action')).toHaveAttribute('role', 'menuitem')
  fireEvent.keyDown(screen.getByTestId('first-action'), { key: 'End' })
  expect(screen.getByTestId('second-action')).toHaveFocus()
  fireEvent.keyDown(screen.getByTestId('second-action'), { key: 'Home' })
  expect(screen.getByTestId('first-action')).toHaveFocus()
  fireEvent.keyDown(screen.getByTestId('first-action'), { key: 'Escape' })
  expect(screen.queryByRole('menu')).not.toBeInTheDocument()
  expect(trigger).toHaveFocus()
  fireEvent.keyDown(trigger, { key: 'ArrowUp' })
  await waitFor(() => expect(screen.getByTestId('second-action')).toHaveFocus())
  fireEvent.keyDown(screen.getByTestId('second-action'), { key: 'Tab' })
  expect(screen.queryByRole('menu')).not.toBeInTheDocument()
})

test('Escape inside a menu closes that menu without dismissing its parent dialog', () => {
  const closeParent = vi.fn()
  render(
    <ModalDialog title="Owned dialog" testId="owned-dialog" onClose={closeParent}>
      {fixture().menu}
    </ModalDialog>
  )
  fireEvent.click(screen.getByTestId('owned-actions'))
  fireEvent.keyDown(screen.getByTestId('first-action'), { key: 'Escape' })
  expect(closeParent).not.toHaveBeenCalled()
  expect(screen.getByRole('dialog')).toBeInTheDocument()
  expect(screen.queryByRole('menu')).not.toBeInTheDocument()
})

test('bottom-end menus stay inside the viewport after the trigger moves below it', () => {
  const geometry = vi
    .spyOn(HTMLElement.prototype, 'getBoundingClientRect')
    .mockImplementation(function (this: HTMLElement) {
      return this.getAttribute('role') === 'menu'
        ? new DOMRect(0, 0, 176, 144)
        : new DOMRect(300, window.innerHeight + 100, 28, 28)
    })
  try {
    render(fixture('bottom-end').menu)
    fireEvent.click(screen.getByTestId('owned-actions'))
    expect(parseFloat(screen.getByRole('menu').style.top) + 144).toBeLessThanOrEqual(
      window.innerHeight - 8
    )
  } finally {
    geometry.mockRestore()
  }
})
