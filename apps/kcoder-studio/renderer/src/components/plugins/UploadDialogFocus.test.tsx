import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { useState } from 'react'
import { expect, test, vi } from 'vitest'
import '@/i18n'
import { PluginUploadDialog } from './PluginUploadDialog'
import { SkillUploadDialog } from './SkillUploadDialog'
test.each([
  { name: 'plugin', Dialog: PluginUploadDialog },
  { name: 'skill', Dialog: SkillUploadDialog },
])('$name upload keeps the dialog open while an upload is pending', async ({ Dialog }) => {
  const onCancel = vi.fn()
  render(<Dialog isUploading onCancel={onCancel} onUpload={vi.fn()} />)
  await userEvent.keyboard('{Escape}')
  expect(screen.getByRole('dialog')).toHaveAttribute('aria-busy', 'true')
  expect(onCancel).not.toHaveBeenCalled()
})
test.each([
  { name: 'plugin', Dialog: PluginUploadDialog },
  { name: 'skill', Dialog: SkillUploadDialog },
])(
  '$name upload owns focus, traps Tab, closes with Escape and returns focus',
  async ({ Dialog }) => {
    function Host() {
      const [open, setOpen] = useState(false)
      return (
        <>
          <button onClick={() => setOpen(true)}>Open upload</button>
          {open && (
            <Dialog isUploading={false} onCancel={() => setOpen(false)} onUpload={vi.fn()} />
          )}
        </>
      )
    }
    const user = userEvent.setup()
    render(<Host />)
    const trigger = screen.getByRole('button', { name: 'Open upload' })
    await user.click(trigger)
    const dialog = screen.getByRole('dialog')
    expect(dialog.contains(document.activeElement)).toBe(true)
    for (let index = 0; index < 8; index++) {
      await user.tab()
      expect(dialog.contains(document.activeElement)).toBe(true)
    }
    await user.keyboard('{Escape}')
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    expect(trigger).toHaveFocus()
  }
)
