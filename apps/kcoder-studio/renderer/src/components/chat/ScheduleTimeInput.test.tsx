import { fireEvent, render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { useState } from 'react'
import { expect, test, vi } from 'vitest'
import '@/i18n'
import { ScheduleTimeInput } from './ScheduleTimeInput'

function Harness() {
  const [value, setValue] = useState('09:30')
  return (
    <>
      <ScheduleTimeInput type="time" value={value} onChange={setValue} testId="time" />
      <button data-testid="outside">Outside</button>
    </>
  )
}

test('selects hours and minutes without closing prematurely and restores keyboard focus', async () => {
  render(<Harness />)
  await userEvent.click(screen.getByTestId('time-picker'))
  await userEvent.click(screen.getByTestId('time-hour-14'))
  expect(screen.getByTestId('time')).toHaveValue('14:30')
  expect(screen.getByTestId('time-panel')).toBeInTheDocument()
  await userEvent.click(screen.getByTestId('time-minute-45'))
  expect(screen.getByTestId('time')).toHaveValue('14:45')
  expect(screen.getByTestId('time-minute-45')).toHaveAttribute('aria-selected', 'true')
  await userEvent.click(screen.getByTestId('time-done'))
  expect(screen.queryByTestId('time-panel')).not.toBeInTheDocument()
  expect(screen.getByTestId('time')).toHaveFocus()
})

test('supports keyboard selection, Escape and outside dismissal while preserving typed values', async () => {
  render(<Harness />)
  fireEvent.change(screen.getByTestId('time'), { target: { value: '18:20' } })
  await userEvent.click(screen.getByTestId('time-picker'))
  const hour = screen.getByTestId('time-hour-18')
  hour.focus()
  await userEvent.keyboard('{ArrowDown}')
  expect(screen.getByTestId('time')).toHaveValue('19:20')
  await userEvent.keyboard('{Escape}')
  expect(screen.queryByTestId('time-panel')).not.toBeInTheDocument()
  expect(screen.getByTestId('time')).toHaveFocus()
  await userEvent.click(screen.getByTestId('time-picker'))
  expect(within(screen.getByTestId('time-panel')).getAllByRole('listbox')).toHaveLength(2)
  await userEvent.click(screen.getByTestId('outside'))
  expect(screen.queryByTestId('time-panel')).not.toBeInTheDocument()
})

test('opens the native date-time picker without changing its value or seconds', async () => {
  const changed = vi.fn()
  render(
    <ScheduleTimeInput
      type="datetime-local"
      value="2030-02-03T14:25:37"
      onChange={changed}
      testId="date"
    />
  )
  const input = screen.getByTestId('date') as HTMLInputElement
  const originalValue = input.value
  const picker = vi.fn()
  Object.defineProperty(input, 'showPicker', { value: picker })
  await userEvent.click(screen.getByTestId('date-picker'))
  expect(picker).toHaveBeenCalledOnce()
  expect(input.value).toBe(originalValue)
  expect(changed).not.toHaveBeenCalled()
})
