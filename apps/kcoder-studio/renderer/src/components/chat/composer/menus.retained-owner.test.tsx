import { fireEvent, render, renderHook, screen } from '@testing-library/react'
import { expect, test, vi } from 'vitest'
import { RetainedPage } from '@/components/layout/retainedPages'
import { ExecutionModeInfo } from './ExecutionModeInfo'
import { useMobileModelSelectorFocus } from './model-selector-mobile-utils'

vi.mock('@/hooks/useTranslation', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}))

test.each(['escape', 'outside'] as const)('hidden menu ignores another page %s event', event => {
  function Menu({ active }: { active: boolean }) {
    return <RetainedPage open={active}><ExecutionModeInfo text="Original mode" /></RetainedPage>
  }
  const view = render(<Menu active />)
  fireEvent.click(screen.getByTestId('execution-mode-info-button'))
  expect(screen.getByTestId('execution-mode-info')).toBeVisible()
  view.rerender(<Menu active={false} />)
  if (event === 'escape') fireEvent.keyDown(document, { key: 'Escape' })
  else fireEvent.pointerDown(document.body)
  view.rerender(<Menu active />)
  expect(screen.getByTestId('execution-mode-info')).toBeVisible()
})

test('a hidden mobile model sheet cannot steal focus from the active page', () => {
  const opener = document.createElement('button')
  const close = document.createElement('button')
  document.body.append(opener, close)
  opener.focus()
  const hook = renderHook(() => useMobileModelSelectorFocus(true, true, { current: close }), {
    wrapper: ({ children }) => <RetainedPage open={false}>{children}</RetainedPage>,
  })
  expect(opener).toHaveFocus()
  hook.unmount()
  opener.remove()
  close.remove()
})
