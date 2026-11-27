import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import { Check } from 'lucide-react'
import '@/i18n'
import { ActionMenu } from '@/components/common/ActionMenu'
const css = readFileSync(resolve(dirname(fileURLToPath(import.meta.url)), 'overlay-motion.css'), 'utf8')

let style: HTMLStyleElement
let fixture: HTMLDivElement

beforeEach(() => {
  style = document.createElement('style')
  style.textContent = css
  document.head.append(style)
  fixture = document.createElement('div')
  document.body.append(fixture)
})
afterEach(() => {
  style.remove()
  fixture.remove()
})

function element(markup: string) {
  fixture.innerHTML = markup
  return fixture.firstElementChild as HTMLElement
}

test('semantic overlays fade without replacing the positioner transform or input behavior', () => {
  const dialog = element('<div role="dialog" style="position:fixed;left:50%;top:50%;transform:translate(-50%,-50%)"><button>Confirm</button></div>')
  const visual = getComputedStyle(dialog)
  expect(visual.animationName).toBe('studio-overlay-enter')
  expect(visual.transform).toBe('translate(-50%,-50%)')
  expect(visual.position).toBe('fixed')
  expect(visual.left).toBe('50%')
  expect(visual.top).toBe('50%')
  expect(visual.pointerEvents).not.toBe('none')
  dialog.querySelector('button')!.focus()
  expect(document.activeElement).toBe(dialog.querySelector('button'))
  dialog.remove()
  expect(dialog.isConnected).toBe(false)
})

test('only an explicitly marked selector surface animates, never listbox content or rows', () => {
  const popup = element('<div role="listbox" data-overlay-motion="popover"><button role="option">First</button><div role="listbox">Inline list</div></div>')
  expect(getComputedStyle(popup).animationName).toBe('studio-overlay-enter')
  expect(getComputedStyle(popup.querySelector('[role="option"]')!).animationName).toBe('')
  expect(getComputedStyle(popup.querySelector('[role="listbox"]')!).animationName).toBe('')
  popup.querySelector('button')!.textContent = 'Updated streaming content'
  expect(getComputedStyle(popup).animationName).toBe('studio-overlay-enter')
  expect(getComputedStyle(popup.querySelector('button')!).animationName).toBe('')
})

test.each([
  '<div class="ant-modal"><div role="dialog" class="ant-modal-content"></div></div>',
  '<div role="menu" class="ant-dropdown-menu"></div>',
  '<div role="dialog" class="octop-modal"></div>',
  '<div role="menu" class="octop-dropdown-menu"></div>',
  '<div role="dialog" class="octop-drawer-content"></div>',
  '<div role="dialog" data-overlay-motion="none"></div>',
  '<div role="menu" class="animate-in"></div>',
  '<div role="dialog" style="animation: existing 1s linear"></div>',
  '<div role="dialog" style="opacity:0.5"></div>',
  '<div role="menu" style="visibility:hidden"></div>',
  '<div role="dialog" hidden></div>',
  '<div inert><div role="dialog"></div></div>',
  '<div data-overlay-motion="none"><div role="menu"></div></div>',
])('leaves existing motion or inactive surfaces alone: %s', markup => {
  const root = element(markup)
  const overlay = root.matches('[role]') ? root : root.querySelector('[role]')!
  expect(getComputedStyle(overlay).animationName).not.toBe('studio-overlay-enter')
})

test('a Studio-owned popup inside OctopSurface still receives its own entrance', () => {
  const surface = element('<div class="octop-surface"><div role="dialog" data-overlay-motion="dialog"></div></div>')
  expect(getComputedStyle(surface.querySelector('[role="dialog"]')!).animationName).toBe('studio-overlay-enter')
})

test('a popup nested in a drawer uses its own short duration', () => {
  const drawer = element('<div role="dialog" data-overlay-motion="drawer"><div role="menu"></div></div>')
  expect(getComputedStyle(drawer).getPropertyValue('--studio-overlay-duration')).toBe('var(--duration-panel, 200ms)')
  expect(getComputedStyle(drawer.querySelector('[role="menu"]')!).getPropertyValue('--studio-overlay-duration')).toBe('var(--duration-base)')
})

test('ActionMenu focuses immediately and closes before an asynchronous action completes', async () => {
  let finish!: () => void
  const action = vi.fn(() => new Promise<void>(resolve => { finish = resolve }))
  render(<ActionMenu testId="motion-action" ariaLabel="Actions" items={[{ testId: 'apply', icon: Check, label: 'Apply', onSelect: action }]} />)
  const trigger = screen.getByRole('button', { name: 'Actions' })
  fireEvent.keyDown(trigger, { key: 'ArrowDown' })
  const item = await screen.findByRole('menuitem', { name: 'Apply' })
  await waitFor(() => expect(document.activeElement).toBe(item))
  expect(getComputedStyle(screen.getByRole('menu')).animationName).toBe('studio-overlay-enter')
  await userEvent.click(item)
  expect(action).toHaveBeenCalledOnce()
  expect(screen.queryByRole('menu')).not.toBeInTheDocument()
  expect(document.activeElement).toBe(trigger)
  finish()
})
import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
