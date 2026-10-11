import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import '@/i18n'
import { DesktopMenuBar } from './DesktopMenuBar'

const labels = ['文件', '编辑', '视图', '窗口', '自动化']
const bridge = {
  list: vi.fn(),
  setVisible: vi.fn(),
  open: vi.fn(),
}

beforeEach(() => {
  bridge.list.mockReset().mockResolvedValue(labels.map((label, index) => ({ index, label })))
  bridge.setVisible.mockReset().mockResolvedValue(undefined)
  bridge.open.mockReset().mockResolvedValue(undefined)
  Object.defineProperty(window, 'kcoderDesktopMenu', { configurable: true, value: bridge })
})

afterEach(() => {
  cleanup()
  Reflect.deleteProperty(window, 'kcoderDesktopMenu')
})

async function ready() {
  await screen.findByRole('menubar')
  await waitFor(() => expect(bridge.setVisible).toHaveBeenCalledWith(true))
  return screen.getAllByRole('menuitem')
}

// These fixtures exercise the model-independent desktop IPC and focus boundary.
test('does not invent menu content without the Windows desktop bridge', () => {
  Reflect.deleteProperty(window, 'kcoderDesktopMenu')
  render(<DesktopMenuBar />)
  expect(screen.queryByRole('menubar')).not.toBeInTheDocument()
  expect(bridge.list).not.toHaveBeenCalled()
})

test('preserves the complete host labels and menu indexes with compact themed styling', async () => {
  bridge.list.mockResolvedValue(labels.map((label, index) => ({ index: index + 3, label })))
  render(<DesktopMenuBar />)
  const items = await ready()
  expect(items.map(item => item.textContent)).toEqual(labels)
  expect(items.map(item => item.tabIndex)).toEqual([0, -1, -1, -1, -1])
  expect(screen.getByRole('menubar')).toHaveClass('h-8', 'min-w-0')
  expect(items[0]).toHaveClass('text-sm', 'font-normal', 'text-text-secondary')
  fireEvent.click(items[1])
  await waitFor(() => expect(bridge.open).toHaveBeenCalledWith(4, 0, 0))
})

test('pointer activation preserves the input focus and selection for native edit roles', async () => {
  const user = userEvent.setup()
  render(
    <>
      <textarea aria-label="Composer" defaultValue="selected content" />
      <DesktopMenuBar />
    </>
  )
  const items = await ready()
  const input = screen.getByRole('textbox') as HTMLTextAreaElement
  input.focus()
  input.setSelectionRange(0, 8)
  bridge.open.mockImplementation(async () => {
    expect(input).toHaveFocus()
    expect([input.selectionStart, input.selectionEnd]).toEqual([0, 8])
  })
  await user.click(items[1])
  expect(input).toHaveFocus()
  expect(bridge.open).toHaveBeenCalledTimes(1)
})

test('F10 and standalone Alt enter the roving menu, Escape restores the original focus', async () => {
  render(
    <>
      <textarea aria-label="Composer" />
      <DesktopMenuBar />
    </>
  )
  const items = await ready()
  const input = screen.getByRole('textbox')
  input.focus()
  fireEvent.keyDown(input, { key: 'F10' })
  expect(items[0]).toHaveFocus()
  fireEvent.keyDown(items[0], { key: 'ArrowLeft' })
  expect(items[4]).toHaveFocus()
  fireEvent.keyDown(items[4], { key: 'Home' })
  expect(items[0]).toHaveFocus()
  fireEvent.keyDown(items[0], { key: 'ArrowRight' })
  expect(items[1]).toHaveFocus()
  fireEvent.keyDown(items[1], { key: 'End' })
  expect(items[4]).toHaveFocus()
  fireEvent.keyDown(items[4], { key: 'Escape' })
  expect(input).toHaveFocus()
  fireEvent.keyDown(input, { key: 'Alt' })
  fireEvent.keyUp(input, { key: 'Alt' })
  expect(items[4]).toHaveFocus()
  fireEvent.keyDown(items[4], { key: 'F10' })
  expect(input).toHaveFocus()
  fireEvent.keyDown(input, { key: 'Alt' })
  fireEvent.keyDown(input, { key: 'a', altKey: true })
  fireEvent.keyUp(input, { key: 'Alt' })
  expect(input).toHaveFocus()
})

test.each(['Enter', ' ', 'ArrowDown'])(
  'keyboard %s preserves the editing target while native menu is open',
  async key => {
    render(
      <>
        <textarea aria-label="Composer" defaultValue="copy me" />
        <DesktopMenuBar />
      </>
    )
    const items = await ready()
    const input = screen.getByRole('textbox') as HTMLTextAreaElement
    input.focus()
    input.setSelectionRange(0, 4)
    fireEvent.keyDown(input, { key: 'F10' })
    let close!: () => void
    bridge.open.mockImplementation(
      () =>
        new Promise<void>(resolve => {
          close = resolve
        })
    )
    fireEvent.keyDown(items[0], { key })
    expect(input).toHaveFocus()
    expect(input.selectionEnd).toBe(4)
    expect(items[0]).toHaveAttribute('aria-expanded', 'true')
    fireEvent.click(items[1])
    expect(bridge.open).toHaveBeenCalledTimes(1)
    await act(async () => close())
    expect(items[0]).toHaveFocus()
    expect(items[0]).toHaveAttribute('aria-expanded', 'false')
  }
)

test.each(['list', 'setVisible', 'open'] as const)(
  'falls back to the native menu after %s failure',
  async method => {
    bridge[method].mockRejectedValueOnce(new Error('IPC unavailable'))
    render(<DesktopMenuBar />)
    if (method === 'open') {
      const items = await ready()
      fireEvent.click(items[0])
    }
    await waitFor(() => expect(bridge.setVisible).toHaveBeenCalledWith(false))
    expect(screen.queryByRole('menubar')).not.toBeInTheDocument()
  }
)

test('an empty host menu falls back without fabricated commands', async () => {
  bridge.list.mockResolvedValue([])
  render(<DesktopMenuBar />)
  await waitFor(() => expect(bridge.setVisible).toHaveBeenCalledWith(false))
  expect(screen.queryByRole('menubar')).not.toBeInTheDocument()
})

test('unmount restores the native bar even when restoring rejects', async () => {
  const { unmount } = render(<DesktopMenuBar />)
  await ready()
  bridge.setVisible.mockRejectedValue(new Error('window closed'))
  await act(async () => unmount())
  expect(bridge.setVisible).toHaveBeenLastCalledWith(false)
})

test('late list completion after unmount never hides the native bar', async () => {
  let complete!: (items: Array<{ index: number; label: string }>) => void
  bridge.list.mockImplementation(
    () =>
      new Promise(resolve => {
        complete = resolve
      })
  )
  const { unmount } = render(<DesktopMenuBar />)
  unmount()
  await act(async () => complete([{ index: 0, label: '文件' }]))
  expect(bridge.setVisible).not.toHaveBeenCalledWith(true)
  expect(bridge.setVisible).toHaveBeenLastCalledWith(false)
})

test('positions the native menu below its trigger in viewport coordinates', async () => {
  render(<DesktopMenuBar />)
  const items = await ready()
  vi.spyOn(items[1], 'getBoundingClientRect').mockReturnValue({
    left: 50.2,
    bottom: 31.8,
  } as DOMRect)
  fireEvent.click(items[1])
  await waitFor(() => expect(bridge.open).toHaveBeenCalledWith(1, 50, 32))
})

test('keyboard menu restores a contenteditable selection for native copy', async () => {
  render(
    <>
      <div role="textbox" aria-label="Editor" contentEditable suppressContentEditableWarning>
        selected text
      </div>
      <DesktopMenuBar />
    </>
  )
  const items = await ready()
  const editor = screen.getByRole('textbox')
  editor.focus()
  const range = document.createRange()
  range.setStart(editor.firstChild!, 0)
  range.setEnd(editor.firstChild!, 8)
  window.getSelection()?.removeAllRanges()
  window.getSelection()?.addRange(range)
  fireEvent.keyDown(editor, { key: 'F10' })
  window.getSelection()?.removeAllRanges()
  bridge.open.mockImplementation(async () => {
    expect(editor).toHaveFocus()
    expect(window.getSelection()?.toString()).toBe('selected')
  })
  fireEvent.keyDown(items[0], { key: 'Enter' })
  await waitFor(() => expect(items[0]).toHaveAttribute('aria-expanded', 'false'))
  expect(bridge.open).toHaveBeenCalledTimes(1)
})

test('closing a native menu does not steal focus from a newly opened dialog', async () => {
  render(
    <>
      <textarea aria-label="Composer" />
      <input aria-label="Dialog" />
      <DesktopMenuBar />
    </>
  )
  const items = await ready()
  screen.getByRole('textbox', { name: 'Composer' }).focus()
  fireEvent.keyDown(document.activeElement!, { key: 'F10' })
  let close!: () => void
  bridge.open.mockImplementation(
    () =>
      new Promise<void>(resolve => {
        close = resolve
      })
  )
  fireEvent.keyDown(items[0], { key: 'Enter' })
  const dialog = screen.getByRole('textbox', { name: 'Dialog' })
  dialog.focus()
  await act(async () => close())
  expect(dialog).toHaveFocus()
})

test('Escape leaves the menu when no input was originally focused', async () => {
  render(<DesktopMenuBar />)
  const items = await ready()
  fireEvent.keyDown(window, { key: 'F10' })
  expect(items[0]).toHaveFocus()
  fireEvent.keyDown(items[0], { key: 'Escape' })
  expect(document.body).toHaveFocus()
})

test('custom menu preserves composer selection when invoking native edit commands', async () => {
  const user = userEvent.setup()
  const invoke = vi.fn(async () => {
    const input = screen.getByRole('textbox') as HTMLTextAreaElement
    expect(input).toHaveFocus()
    expect([input.selectionStart, input.selectionEnd]).toEqual([0, 4])
  })
  Object.defineProperty(window, 'kcoderDesktopMenu', {
    configurable: true,
    value: { ...bridge, invoke },
  })
  bridge.list.mockResolvedValue([
    {
      index: 1,
      id: 'edit',
      label: 'Edit',
      entries: [
        {
          position: 0,
          id: 'copy',
          label: 'Copy',
          enabled: true,
          visible: true,
          checked: false,
          accelerator: 'Ctrl+C',
        },
        {
          position: 1,
          id: 'paste',
          label: 'Paste',
          enabled: false,
          visible: true,
          checked: false,
          accelerator: 'Ctrl+V',
        },
      ],
    },
  ])
  render(
    <>
      <textarea aria-label="Composer" defaultValue="copy me" />
      <DesktopMenuBar />
    </>
  )
  const items = await ready()
  const input = screen.getByRole('textbox') as HTMLTextAreaElement
  input.focus()
  input.setSelectionRange(0, 4)
  await user.click(items[0])
  expect(screen.getByRole('menu', { name: 'Edit' })).toBeVisible()
  expect(screen.getByTestId('desktop-command-paste')).toBeDisabled()
  await user.click(screen.getByTestId('desktop-command-copy'))
  expect(invoke).toHaveBeenCalledWith(1, 0)
  expect(screen.queryByRole('menu')).not.toBeInTheDocument()
  await user.click(items[0])
  await user.keyboard('{Escape}')
  expect(items[0]).toHaveFocus()
  await user.keyboard('{Escape}')
  expect(input).toHaveFocus()
})
