import { fireEvent, render, screen } from '@testing-library/react'
import { useRef } from 'react'
import { createPortal } from 'react-dom'
import { expect, test, vi } from 'vitest'
import { useOutsideClick } from './useOutsideClick'

test.each([false, true])('trigger and portal share an outside-click boundary, capture=%s', capture => {
  const close = vi.fn()
  function Menu() {
    const trigger = useRef<HTMLButtonElement>(null)
    const content = useRef<HTMLDivElement>(null)
    useOutsideClick([trigger, content], true, close, capture)
    return <>
      <button ref={trigger}>Trigger</button>
      {createPortal(<div ref={content}>Portal content</div>, document.body)}
      <button onPointerDown={event => event.stopPropagation()}>Outside with propagation stopped</button>
    </>
  }
  render(<Menu />)
  fireEvent.pointerDown(screen.getByText('Trigger'))
  fireEvent.pointerDown(screen.getByText('Portal content'))
  expect(close).not.toHaveBeenCalled()
  fireEvent.pointerDown(screen.getByText('Outside with propagation stopped'))
  expect(close).toHaveBeenCalledTimes(capture ? 1 : 0)
  fireEvent.pointerDown(document.body)
  expect(close).toHaveBeenCalledTimes(capture ? 2 : 1)
})
