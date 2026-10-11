import { createRef } from 'react'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { expect, test, vi } from 'vitest'
import { Checkbox } from './checkbox'

test('supports label clicks, Space and native form values', async () => {
  const user = userEvent.setup()
  const change = vi.fn()
  render(
    <form aria-label="Options">
      <label>
        <Checkbox name="capability" value="tools" onChange={change} />
        Tools
      </label>
    </form>
  )
  const input = screen.getByRole('checkbox', { name: 'Tools' })
  await user.click(screen.getByText('Tools'))
  expect(input).toBeChecked()
  expect(new FormData(screen.getByRole('form') as HTMLFormElement).get('capability')).toBe('tools')
  input.focus()
  await user.keyboard(' ')
  expect(input).not.toBeChecked()
  expect(change).toHaveBeenCalledTimes(2)
})
test('preserves mixed state and forwarded refs, and respects a disabled fieldset', async () => {
  const user = userEvent.setup()
  const ref = createRef<HTMLInputElement>()
  const { rerender } = render(<Checkbox ref={ref} indeterminate aria-label="Selection" />)
  expect(ref.current).toBe(screen.getByRole('checkbox'))
  expect(ref.current?.indeterminate).toBe(true)
  rerender(
    <fieldset disabled>
      <Checkbox ref={ref} aria-label="Selection" />
    </fieldset>
  )
  expect(ref.current?.indeterminate).toBe(false)
  expect(screen.getByRole('checkbox')).toBeDisabled()
  await user.click(screen.getByRole('checkbox'))
  expect(screen.getByRole('checkbox')).not.toBeChecked()
})
