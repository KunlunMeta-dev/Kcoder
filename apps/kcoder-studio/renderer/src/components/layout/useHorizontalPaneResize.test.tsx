import { act, fireEvent, render, screen } from '@testing-library/react'
import { useRef } from 'react'
import { useHorizontalPaneResize } from './useHorizontalPaneResize'

test('divider supports bounded dragging, keyboard control, container resizing and cleanup', () => {
  let containerWidth = 1000
  let notify!: () => void
  const bounds = vi
    .spyOn(HTMLElement.prototype, 'getBoundingClientRect')
    .mockImplementation(() => ({ width: containerWidth }) as DOMRect)
  vi.stubGlobal(
    'ResizeObserver',
    class {
      constructor(callback: () => void) {
        notify = callback
      }
      observe() {}
      disconnect() {}
    }
  )
  function Harness() {
    const ref = useRef<HTMLDivElement>(null)
    const split = useHorizontalPaneResize({
      containerRef: ref,
      initialWidth: 240,
      minWidth: 200,
      minRemaining: 400,
      maxWidth: 600,
    })
    return (
      <div ref={ref}>
        <div data-testid="handle" {...split.handleProps} />
      </div>
    )
  }
  const view = render(<Harness />)
  const handle = screen.getByTestId('handle')
  expect(handle).toHaveAttribute('aria-valuenow', '240')
  fireEvent.pointerDown(handle, { button: 0, clientX: 240 })
  fireEvent.pointerMove(document, { clientX: 350 })
  expect(handle).toHaveAttribute('aria-valuenow', '350')
  fireEvent.pointerMove(document, { clientX: 2000 })
  expect(handle).toHaveAttribute('aria-valuenow', '600')
  fireEvent.pointerCancel(document)
  expect(document.body.style.cursor).toBe('')
  fireEvent.keyDown(handle, { key: 'Home' })
  expect(handle).toHaveAttribute('aria-valuenow', '200')
  fireEvent.keyDown(handle, { key: 'ArrowRight' })
  expect(handle).toHaveAttribute('aria-valuenow', '216')
  fireEvent.keyDown(handle, { key: 'End' })
  act(() => {
    containerWidth = 700
    notify()
  })
  expect(handle).toHaveAttribute('aria-valuenow', '300')
  fireEvent.doubleClick(handle)
  expect(handle).toHaveAttribute('aria-valuenow', '240')
  fireEvent.pointerDown(handle, { button: 0, clientX: 240 })
  view.unmount()
  expect(document.body.style.cursor).toBe('')
  expect(document.body.style.userSelect).toBe('')
  bounds.mockRestore()
  vi.unstubAllGlobals()
})
