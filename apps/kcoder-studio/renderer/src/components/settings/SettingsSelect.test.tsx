import { render, screen, fireEvent, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { useState } from 'react'
import { expect, test } from 'vitest'
import { SettingsSelect } from './SettingsSelect'
function Fixture({ disabled = false }: { disabled?: boolean }) {
  const [value, setValue] = useState('key')
  return (
    <label>
      Authentication
      <SettingsSelect
        aria-label="Authentication"
        icon={<span />}
        disabled={disabled}
        value={value}
        onChange={event => setValue(event.target.value)}
      >
        <option value="key">Private key</option>
        <option value="password">Password</option>
        <option value="agent" disabled>
          Agent
        </option>
      </SettingsSelect>
    </label>
  )
}
test('opens a themed popup, skips disabled options, commits via the native change boundary and restores focus', async () => {
  const user = userEvent.setup()
  render(<Fixture />)
  const select = screen.getByRole('combobox')
  fireEvent.keyDown(select, { key: 'ArrowDown' })
  const menu = screen.getByRole('listbox')
  expect(within(menu).getByRole('option', { name: 'Private key' })).toHaveFocus()
  await user.keyboard('{ArrowDown}{Enter}')
  expect(select).toHaveValue('password')
  expect(select).toHaveFocus()
  expect(screen.queryByRole('listbox')).not.toBeInTheDocument()
  fireEvent.keyDown(select, { key: 'ArrowDown' })
  await user.keyboard('{ArrowDown}')
  expect(
    within(screen.getByRole('listbox')).getByRole('option', { name: 'Private key' })
  ).toHaveFocus()
  await user.keyboard('{Escape}')
  expect(select).toHaveValue('password')
  expect(select).toHaveFocus()
})
test('disabled selectors cannot open; outside clicks dismiss without changing value', () => {
  const { rerender } = render(<Fixture disabled />)
  fireEvent.mouseDown(screen.getByRole('combobox'))
  expect(screen.queryByRole('listbox')).not.toBeInTheDocument()
  rerender(<Fixture />)
  fireEvent.mouseDown(screen.getByRole('combobox'))
  expect(screen.getByRole('listbox')).toBeVisible()
  fireEvent.pointerDown(document.body)
  expect(screen.queryByRole('listbox')).not.toBeInTheDocument()
  expect(screen.getByRole('combobox')).toHaveValue('key')
})
test('reserves the longest option width on the trigger and sizes the popup to its content', () => {
  render(
    <SettingsSelect aria-label="Frequency" value="few" onChange={() => {}}>
      <option value="few">每次</option>
      <option value="many">每累计 10 次使用后整理一次</option>
    </SettingsSelect>
  )
  // Invisible copies of every option keep the trigger from resizing when the value changes.
  const reserve = Array.from(document.querySelectorAll('[data-stable-reserve-text]'))
  expect(reserve.map(node => node.getAttribute('data-stable-reserve-text'))).toEqual([
    '每次',
    '每累计 10 次使用后整理一次',
  ])
  // The reservation adds no DOM text and stays out of the accessibility tree.
  expect(reserve.every(node => node.textContent === '' && node.closest('[aria-hidden="true"]'))).toBe(true)
  fireEvent.mouseDown(screen.getByRole('combobox'))
  const popup = screen.getByRole('listbox')
  // A collapsed trigger can no longer squeeze labels into one character per line.
  expect(popup.style.width).toBe('max-content')
  expect(Number.parseFloat(popup.style.minWidth)).toBeGreaterThanOrEqual(240)
  expect(Number.parseFloat(popup.style.maxWidth)).toBe(window.innerWidth - 16)
})
