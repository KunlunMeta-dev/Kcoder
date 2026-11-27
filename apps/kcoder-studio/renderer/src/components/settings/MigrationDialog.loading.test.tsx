import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { useState } from 'react'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import '@/i18n'
import { MigrationDialog, type MigrationDialogProps } from './MigrationDialog'

let resolve: (module: { MigrationDialogContent: typeof Content }) => void
let reject: (error: Error) => void
const requested = vi.fn()
const rendered = vi.fn()
function Content(props: Omit<MigrationDialogProps, 'onClose'>) {
  rendered(props)
  return <div data-testid="loaded-migration">{props.workspacePath}</div>
}
function Entry() {
  const [open, setOpen] = useState(false)
  return <><button onClick={() => setOpen(true)}>import</button>
    {open && <MigrationDialog onClose={() => setOpen(false)} />}</>
}
beforeEach(() => {
  requested.mockClear()
  rendered.mockClear()
  const loading = new Promise<{ MigrationDialogContent: typeof Content }>((done, fail) => {
    resolve = done
    reject = fail
  })
  vi.doMock('./MigrationDialogContent', () => { requested(); return loading })
})
afterEach(() => { cleanup(); vi.doUnmock('./MigrationDialogContent') })

test.each(['close', 'Escape'])('the unopened entry loads nothing and remains dismissible by %s while loading', async action => {
  render(<Entry />)
  expect(requested).not.toHaveBeenCalled()
  fireEvent.click(screen.getByText('import'))
  await waitFor(() => expect(requested).toHaveBeenCalledOnce())
  expect(screen.getByRole('status')).toHaveAttribute('aria-busy', 'true')
  const shell = screen.getByRole('dialog')
  if (action === 'close') fireEvent.click(screen.getByTestId('migration-dialog-close'))
  else fireEvent.keyDown(document, { key: 'Escape' })
  expect(shell).not.toBeInTheDocument()
  await act(async () => { resolve({ MigrationDialogContent: Content }) })
  expect(rendered).not.toHaveBeenCalled()
  expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
})

test('content uses the current props after loading without replacing its dialog shell', async () => {
  const close = vi.fn()
  const view = render(<MigrationDialog workspacePath="/old" onClose={close} />)
  await waitFor(() => expect(requested).toHaveBeenCalledOnce())
  const shell = screen.getByRole('dialog')
  view.rerender(<MigrationDialog workspacePath="/current" initialJobId="current-job" onClose={close} />)
  await act(async () => { resolve({ MigrationDialogContent: Content }) })
  expect(await screen.findByTestId('loaded-migration')).toHaveTextContent('/current')
  expect(rendered).toHaveBeenLastCalledWith({ workspacePath: '/current', initialJobId: 'current-job' })
  expect(screen.getByRole('dialog')).toBe(shell)
  expect(screen.queryByRole('status')).not.toBeInTheDocument()
  fireEvent.keyDown(document, { key: 'Escape' })
  expect(close).toHaveBeenCalledOnce()
})

test('a failed module load stays local and the dialog can still be closed', async () => {
  render(<Entry />)
  fireEvent.click(screen.getByText('import'))
  await waitFor(() => expect(requested).toHaveBeenCalledOnce())
  await act(async () => { reject(new Error('controlled module failure')) })
  expect(await screen.findByRole('alert')).toHaveTextContent('无法加载迁移界面')
  expect(screen.queryByRole('status')).not.toBeInTheDocument()
  expect(rendered).not.toHaveBeenCalled()
  fireEvent.click(screen.getByTestId('migration-dialog-close'))
  expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
})
