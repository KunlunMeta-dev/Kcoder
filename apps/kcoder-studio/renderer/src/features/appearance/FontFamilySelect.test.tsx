import { render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { expect, test, vi } from 'vitest'
import { FontFamilySelect } from './FontFamilySelect'
import { defaultAppearance } from './presets'
import '@/i18n'

test('selects a code font from the popup while retaining the fallback stack', async () => {
  const user = userEvent.setup()
  const change = vi.fn()
  render(<FontFamilySelect kind="code" value={defaultAppearance.codeFont} onChange={change} />)
  expect(screen.getByRole('combobox')).toHaveDisplayValue('系统默认')
  await user.click(screen.getByRole('combobox'))
  await user.click(within(screen.getByRole('listbox')).getByRole('option', { name: 'Consolas' }))
  expect(change).toHaveBeenCalledWith(`'Consolas', ${defaultAppearance.codeFont}`)
})
test('preserves an existing custom font until an explicit choice and supports restoring system default', async () => {
  const user = userEvent.setup()
  const change = vi.fn()
  render(<FontFamilySelect kind="ui" value="My Custom Font, sans-serif" onChange={change} />)
  expect(screen.getByRole('combobox')).toHaveValue('My Custom Font, sans-serif')
  expect(change).not.toHaveBeenCalled()
  await user.click(screen.getByRole('combobox'))
  await user.click(within(screen.getByRole('listbox')).getByRole('option', { name: '系统默认' }))
  expect(change).toHaveBeenCalledWith(defaultAppearance.uiFont)
})
