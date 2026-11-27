import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { useState, type ComponentProps } from 'react'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import i18n from '@/i18n'
import { DeferredWorkflowExecutionCanvas } from './DeferredWorkflowExecutionCanvas'

type Props = ComponentProps<typeof DeferredWorkflowExecutionCanvas>
let finish: (module: { WorkflowExecutionCanvas: typeof Content }) => void
let fail: (error: Error) => void
let originalLanguage: string
const requested = vi.fn(), rendered = vi.fn()
function Content(props: Props) {
  rendered(props)
  return <div data-testid="loaded-workflow-canvas">{props.workspacePath}</div>
}
const address = { serverId: 'owned-target', workspacePath: '/old', threadId: 'original-thread',
  reference: { id: 'original-workflow', version: 2, runId: 'original-run' }, active: true }
function Entry() {
  const [open, setOpen] = useState(false)
  return <><button onClick={() => setOpen(true)}>open-canvas</button>
    {open && <DeferredWorkflowExecutionCanvas {...address} onClose={() => setOpen(false)} />}</>
}
beforeEach(() => {
  originalLanguage = i18n.language
  requested.mockClear(); rendered.mockClear()
  const loading = new Promise<{ WorkflowExecutionCanvas: typeof Content }>((resolve, reject) => {
    finish = resolve; fail = reject
  })
  vi.doMock('./WorkflowExecutionCanvas', () => { requested(); return loading })
})
afterEach(async () => {
  cleanup(); vi.doUnmock('./WorkflowExecutionCanvas')
  await i18n.changeLanguage(originalLanguage)
})

test('an unopened canvas loads nothing; closing while loading rejects the late module', async () => {
  render(<Entry />)
  expect(requested).not.toHaveBeenCalled()
  fireEvent.click(screen.getByText('open-canvas'))
  await waitFor(() => expect(requested).toHaveBeenCalledOnce())
  expect(screen.getByRole('status')).toHaveAttribute('aria-busy', 'true')
  fireEvent.click(screen.getByRole('button', { name: /Close|关闭/ }))
  await act(async () => { finish({ WorkflowExecutionCanvas: Content }) })
  expect(rendered).not.toHaveBeenCalled()
  expect(screen.queryByTestId('workflow-canvas-module')).not.toBeInTheDocument()
})

test('loading uses current target, original run and active props without a new loader', async () => {
  const close = vi.fn(), view = render(<DeferredWorkflowExecutionCanvas {...address} onClose={close} />)
  await waitFor(() => expect(requested).toHaveBeenCalledOnce())
  const current = { ...address, serverId: 'current-target', workspacePath: '/current', active: false }
  view.rerender(<DeferredWorkflowExecutionCanvas {...current} onClose={close} />)
  await act(async () => { finish({ WorkflowExecutionCanvas: Content }) })
  expect(await screen.findByTestId('loaded-workflow-canvas')).toHaveTextContent('/current')
  expect(rendered).toHaveBeenLastCalledWith({ ...current, onClose: close })
  expect(requested).toHaveBeenCalledOnce()
  expect(screen.queryByTestId('workflow-canvas-module')).not.toBeInTheDocument()
})

test.each([
  ['en', 'Unable to load workflows.'], ['zh-CN', '无法读取工作流。'],
])('a failed canvas module stays local and can be dismissed (%s)', async (language, message) => {
  await i18n.changeLanguage(language)
  render(<Entry />)
  fireEvent.click(screen.getByText('open-canvas'))
  await waitFor(() => expect(requested).toHaveBeenCalledOnce())
  await act(async () => { fail(new Error('owned module failure containing internal diagnostics')) })
  expect(await screen.findByRole('alert')).toHaveAttribute('aria-busy', 'false')
  expect(screen.getByRole('alert')).toHaveTextContent(message)
  expect(screen.getByRole('alert')).not.toHaveTextContent('internal diagnostics')
  expect(screen.queryByRole('status')).not.toBeInTheDocument()
  expect(rendered).not.toHaveBeenCalled()
  fireEvent.click(screen.getByRole('button', { name: /Close|关闭/ }))
  expect(screen.queryByTestId('workflow-canvas-module')).not.toBeInTheDocument()
})
