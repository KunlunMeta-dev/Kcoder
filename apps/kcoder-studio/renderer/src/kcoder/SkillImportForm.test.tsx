import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { expect, test, vi } from 'vitest'
import '@/i18n'
import { SkillImportForm } from './SkillImportForm'

test('retains the remote directory after failure and clears it after successful import', async () => {
  const install = vi
    .fn()
    .mockRejectedValueOnce(new Error('Invalid skill'))
    .mockResolvedValue(undefined)
  render(<SkillImportForm disabled={false} install={install} />)
  const input = screen.getByLabelText(/Skill directory|所选主机上的技能目录/)
  fireEvent.change(input, { target: { value: '/remote/skills/demo' } })
  fireEvent.click(screen.getByRole('button', { name: /Import skill|导入技能/ }))
  await screen.findByText('Invalid skill')
  expect(input).toHaveValue('/remote/skills/demo')
  fireEvent.click(screen.getByRole('button', { name: /Import skill|导入技能/ }))
  await waitFor(() => expect(input).toHaveValue(''))
  expect(install).toHaveBeenCalledWith('/remote/skills/demo')
})
