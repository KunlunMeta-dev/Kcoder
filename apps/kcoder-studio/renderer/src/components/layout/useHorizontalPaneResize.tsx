import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type RefObject,
  type PointerEvent,
} from 'react'

/** Local presentation only; resizing never changes a workflow definition. */
export function useHorizontalPaneResize({
  containerRef,
  initialWidth,
  minWidth,
  minRemaining,
  maxWidth = Infinity,
}: {
  containerRef: RefObject<HTMLElement | null>
  initialWidth?: number
  minWidth: number
  minRemaining: number
  maxWidth?: number
}) {
  const [containerWidth, setContainerWidth] = useState(0)
  const [requested, setRequested] = useState<number | null>(null)
  const [resizing, setResizing] = useState(false)
  const cleanup = useRef<(() => void) | null>(null)
  const limit = Math.max(minWidth, Math.min(maxWidth, containerWidth - minRemaining))
  const clamp = (value: number) => Math.max(minWidth, Math.min(limit, value))
  const width = clamp(requested ?? initialWidth ?? containerWidth / 2)
  useLayoutEffect(() => {
    const container = containerRef.current
    if (!container) return
    const update = () => setContainerWidth(container.getBoundingClientRect().width)
    update()
    const observer = new ResizeObserver(update)
    observer.observe(container)
    return () => observer.disconnect()
  }, [containerRef])
  useEffect(() => () => cleanup.current?.(), [])
  const start = (event: PointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) return
    event.preventDefault()
    cleanup.current?.()
    const x = event.clientX
    const cursor = document.body.style.cursor
    const selection = document.body.style.userSelect
    const move = (next: globalThis.PointerEvent) => setRequested(clamp(width + next.clientX - x))
    const finish = () => {
      document.removeEventListener('pointermove', move)
      document.removeEventListener('pointerup', finish)
      document.removeEventListener('pointercancel', finish)
      window.removeEventListener('blur', finish)
      document.body.style.cursor = cursor
      document.body.style.userSelect = selection
      cleanup.current = null
      setResizing(false)
    }
    cleanup.current = finish
    setResizing(true)
    document.body.style.cursor = 'col-resize'
    document.body.style.userSelect = 'none'
    document.addEventListener('pointermove', move)
    document.addEventListener('pointerup', finish)
    document.addEventListener('pointercancel', finish)
    window.addEventListener('blur', finish)
  }
  return {
    width,
    resizing,
    handleProps: {
      role: 'separator' as const,
      tabIndex: 0,
      'aria-orientation': 'vertical' as const,
      'aria-valuemin': minWidth,
      'aria-valuemax': limit,
      'aria-valuenow': Math.round(width),
      onPointerDown: start,
      onDoubleClick: () => setRequested(null),
      onKeyDown: (event: React.KeyboardEvent<HTMLDivElement>) => {
        if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') {
          event.preventDefault()
          setRequested(
            clamp(width + (event.key === 'ArrowLeft' ? -1 : 1) * (event.shiftKey ? 48 : 16))
          )
        } else if (event.key === 'Home' || event.key === 'End') {
          event.preventDefault()
          setRequested(event.key === 'Home' ? minWidth : limit)
        }
      },
    },
  }
}

export const PANE_RESIZE_HANDLE =
  'z-20 w-1.5 shrink-0 touch-none cursor-col-resize rounded-sm bg-transparent hover:bg-primary/20 focus-visible:bg-primary/20 focus-visible:outline-none'
