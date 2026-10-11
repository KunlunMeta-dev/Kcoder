import { act, fireEvent, render, screen } from '@testing-library/react'
import { useResizableBottomPanel } from './useResizableWorkspacePanel'

describe('useResizableBottomPanel', () => {
  test('resizes the panel imperatively without rerendering terminal content while dragging', () => {
    const frames: FrameRequestCallback[] = []
    const requestAnimationFrameSpy = vi
      .spyOn(window, 'requestAnimationFrame')
      .mockImplementation(callback => {
        frames.push(callback)
        return frames.length
      })
    const cancelAnimationFrameSpy = vi
      .spyOn(window, 'cancelAnimationFrame')
      .mockImplementation(() => undefined)
    let renderCount = 0

    function Harness() {
      const { height, resizing, panelRef, handleResizeStart } = useResizableBottomPanel()
      renderCount += 1

      return (
        <section ref={panelRef} data-testid="panel" style={{ height }} data-resizing={resizing}>
          <div data-testid="handle" onPointerDown={handleResizeStart} />
        </section>
      )
    }

    const { unmount } = render(<Harness />)
    fireEvent.pointerDown(screen.getByTestId('handle'), { clientY: 700 })
    expect(renderCount).toBe(2)

    fireEvent.pointerMove(document, { clientY: 660 })
    fireEvent.pointerMove(document, { clientY: 620 })
    expect(frames).toHaveLength(1)

    act(() => frames[0](performance.now()))
    expect(screen.getByTestId('panel')).toHaveStyle({ height: '400px' })
    expect(renderCount).toBe(2)

    fireEvent.pointerUp(document)
    expect(renderCount).toBe(3)
    expect(screen.getByTestId('panel')).toHaveStyle({ height: '400px' })

    fireEvent.pointerDown(screen.getByTestId('handle'), { clientY: 620 })
    expect(document.body.style.cursor).toBe('row-resize')
    unmount()
    expect(document.body.style.cursor).toBe('')
    expect(document.body.style.userSelect).toBe('')

    requestAnimationFrameSpy.mockRestore()
    cancelAnimationFrameSpy.mockRestore()
  })
})

import { fileTreeWidthBounds, useResizableFileTree } from './useResizableWorkspacePanel'

describe('file tree divider', () => {
  test('clamps narrow containers without consuming the preview', () => {
    expect(fileTreeWidthBounds(1000)).toEqual({ min: 160, max: 480 })
    const narrow = fileTreeWidthBounds(300)
    expect(narrow.max).toBe(127)
    expect(narrow.min).toBe(75)
  })
  test('supports keyboard, captured drag, cancellation and unmount cleanup', () => {
    const frames: FrameRequestCallback[] = []
    const raf = vi.spyOn(window, 'requestAnimationFrame').mockImplementation(callback => {
      frames.push(callback)
      return frames.length
    })
    const caf = vi.spyOn(window, 'cancelAnimationFrame').mockImplementation(() => {})
    let renders = 0
    function Harness() {
      renders++
      const split = useResizableFileTree()
      return (
        <div ref={split.containerRef}>
          <div data-testid="tree" ref={split.paneRef} style={{ width: split.width }} />
          <div
            data-testid="divider"
            ref={split.separatorRef}
            tabIndex={0}
            onPointerDown={split.handleResizeStart}
            onKeyDown={split.handleResizeKey}
          />
        </div>
      )
    }
    const view = render(<Harness />)
    const handle = screen.getByTestId('divider')
    fireEvent.keyDown(handle, { key: 'ArrowLeft' })
    expect(screen.getByTestId('tree')).toHaveStyle({ width: '256px' })
    fireEvent.pointerDown(handle, { button: 0, clientX: 500 })
    const during = renders
    fireEvent.pointerMove(document, { clientX: 420 })
    act(() => frames.at(-1)!(performance.now()))
    expect(screen.getByTestId('tree')).toHaveStyle({ width: '336px' })
    expect(renders).toBe(during)
    fireEvent.pointerCancel(document)
    expect(document.body.style.cursor).toBe('')
    expect(screen.getByTestId('tree')).toHaveStyle({ width: '336px' })
    fireEvent.keyDown(handle, { key: 'End' })
    expect(screen.getByTestId('tree')).toHaveStyle({ width: '480px' })
    fireEvent.keyDown(handle, { key: 'Home' })
    expect(screen.getByTestId('tree')).toHaveStyle({ width: '160px' })
    fireEvent.pointerDown(handle, { button: 0, clientX: 500 })
    view.unmount()
    expect(document.body.style.cursor).toBe('')
    expect(document.body.style.userSelect).toBe('')
    raf.mockRestore()
    caf.mockRestore()
  })
})
