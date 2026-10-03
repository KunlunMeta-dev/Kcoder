import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type PointerEvent,
  type RefObject,
} from 'react'

const RIGHT_SPLIT_CHAT_DEFAULT_WIDTH = 420
const RIGHT_SPLIT_CHAT_MIN_WIDTH = 360
const RIGHT_SPLIT_CHAT_MAX_WIDTH = 620
const RIGHT_SPLIT_PANEL_COLLAPSE_WIDTH = 260
const BOTTOM_DEFAULT_HEIGHT = 320
const BOTTOM_MIN_HEIGHT = 220
const BOTTOM_MAX_HEIGHT = 560

function clamp(value: number, min: number, max: number) {
  return Math.min(Math.max(value, min), max)
}

function getRightSplitChatMaxWidth(containerWidth: number) {
  if (containerWidth <= 0) return RIGHT_SPLIT_CHAT_MAX_WIDTH

  return Math.max(RIGHT_SPLIT_CHAT_MIN_WIDTH, containerWidth - RIGHT_SPLIT_PANEL_COLLAPSE_WIDTH)
}

function getRightSplitChatDefaultWidth(containerWidth: number, defaultPanelWidth?: number) {
  if (containerWidth <= 0) return RIGHT_SPLIT_CHAT_DEFAULT_WIDTH

  return clamp(
    defaultPanelWidth === undefined
      ? RIGHT_SPLIT_CHAT_DEFAULT_WIDTH
      : containerWidth - defaultPanelWidth,
    RIGHT_SPLIT_CHAT_MIN_WIDTH,
    getRightSplitChatMaxWidth(containerWidth)
  )
}

interface ResizableRightSplitChatOptions {
  containerRef?: RefObject<HTMLElement | null>
  onCollapse?: () => void
  defaultPanelWidth?: number
}

export function useResizableRightSplitChat({
  containerRef,
  onCollapse,
  defaultPanelWidth,
}: ResizableRightSplitChatOptions = {}) {
  const [width, setWidth] = useState(RIGHT_SPLIT_CHAT_DEFAULT_WIDTH)
  const [resizing, setResizing] = useState(false)
  const collapseFrameRef = useRef<number | null>(null)
  const userSizedRef = useRef(false)

  useLayoutEffect(() => {
    const container = containerRef?.current
    if (!container) return

    const applyDefaultWidth = () => {
      if (userSizedRef.current) return
      setWidth(
        getRightSplitChatDefaultWidth(container.getBoundingClientRect().width, defaultPanelWidth)
      )
    }

    applyDefaultWidth()
    if (typeof ResizeObserver === 'undefined') return

    const observer = new ResizeObserver(applyDefaultWidth)
    observer.observe(container)
    return () => observer.disconnect()
  }, [containerRef, defaultPanelWidth])

  useEffect(() => {
    return () => {
      if (collapseFrameRef.current === null) return
      window.cancelAnimationFrame(collapseFrameRef.current)
    }
  }, [])

  const handleResizeStart = (event: PointerEvent<HTMLDivElement>) => {
    event.preventDefault()

    const startX = event.clientX
    const startWidth = width
    const containerWidth = containerRef?.current?.getBoundingClientRect().width ?? 0
    const maxWidth = getRightSplitChatMaxWidth(containerWidth)
    let collapsed = false
    userSizedRef.current = true

    function finishResize() {
      document.removeEventListener('pointermove', handleMove)
      document.removeEventListener('pointerup', handleUp)
      document.body.style.cursor = ''
      document.body.style.userSelect = ''
      setResizing(false)
    }

    function collapsePanel() {
      if (collapsed) return

      collapsed = true
      finishResize()
      if (collapseFrameRef.current !== null) {
        window.cancelAnimationFrame(collapseFrameRef.current)
      }
      const applyCollapse = () => {
        collapseFrameRef.current = null
        userSizedRef.current = false
        setWidth(getRightSplitChatDefaultWidth(containerWidth, defaultPanelWidth))
        onCollapse?.()
      }

      if (typeof window.requestAnimationFrame === 'function') {
        collapseFrameRef.current = window.requestAnimationFrame(applyCollapse)
        return
      }

      applyCollapse()
    }

    function handleMove(moveEvent: globalThis.PointerEvent) {
      if (collapsed) return

      const rawWidth = startWidth + moveEvent.clientX - startX
      if (onCollapse && rawWidth > startWidth && rawWidth >= maxWidth) {
        collapsePanel()
        return
      }

      const nextWidth = clamp(rawWidth, RIGHT_SPLIT_CHAT_MIN_WIDTH, maxWidth)
      setWidth(nextWidth)
    }

    function handleUp() {
      if (!collapsed) finishResize()
    }

    setResizing(true)
    document.body.style.cursor = 'col-resize'
    document.body.style.userSelect = 'none'
    document.addEventListener('pointermove', handleMove)
    document.addEventListener('pointerup', handleUp)
  }

  return { width, resizing, handleResizeStart }
}

export function useResizableBottomPanel() {
  const [height, setHeight] = useState(BOTTOM_DEFAULT_HEIGHT)
  const [resizing, setResizing] = useState(false)
  const panelRef = useRef<HTMLElement | null>(null)
  const resizeFrameRef = useRef<number | null>(null)
  const activeResizeCleanupRef = useRef<(() => void) | null>(null)

  useEffect(() => {
    return () => {
      activeResizeCleanupRef.current?.()
      if (resizeFrameRef.current !== null) {
        window.cancelAnimationFrame(resizeFrameRef.current)
      }
    }
  }, [])

  const handleResizeStart = (event: PointerEvent<HTMLDivElement>) => {
    event.preventDefault()
    activeResizeCleanupRef.current?.()

    const resizeHandle = event.currentTarget
    if (typeof resizeHandle.setPointerCapture === 'function') {
      try {
        resizeHandle.setPointerCapture(event.pointerId)
      } catch {
        // Synthetic verification events do not create an active browser pointer.
      }
    }

    const startY = event.clientY
    const startHeight = height
    let nextHeight = startHeight

    const applyHeight = () => {
      resizeFrameRef.current = null
      if (panelRef.current) {
        panelRef.current.style.height = `${nextHeight}px`
      }
    }

    const handleMove = (moveEvent: globalThis.PointerEvent) => {
      nextHeight = clamp(
        startHeight + startY - moveEvent.clientY,
        BOTTOM_MIN_HEIGHT,
        BOTTOM_MAX_HEIGHT
      )
      if (resizeFrameRef.current !== null) return

      resizeFrameRef.current = window.requestAnimationFrame(applyHeight)
    }

    const cleanupResize = () => {
      document.removeEventListener('pointermove', handleMove)
      document.removeEventListener('pointerup', handleUp)
      document.removeEventListener('pointercancel', handleCancel)
      if (resizeFrameRef.current !== null) {
        window.cancelAnimationFrame(resizeFrameRef.current)
        resizeFrameRef.current = null
      }
      if (resizeHandle.hasPointerCapture?.(event.pointerId)) {
        resizeHandle.releasePointerCapture(event.pointerId)
      }
      document.body.style.cursor = ''
      document.body.style.userSelect = ''
      activeResizeCleanupRef.current = null
    }

    const finishResize = () => {
      cleanupResize()
      if (panelRef.current) {
        panelRef.current.style.height = `${nextHeight}px`
      }
      setHeight(nextHeight)
      setResizing(false)
    }

    const handleUp = () => finishResize()
    const handleCancel = () => finishResize()

    setResizing(true)
    document.body.style.cursor = 'row-resize'
    document.body.style.userSelect = 'none'
    document.addEventListener('pointermove', handleMove)
    document.addEventListener('pointerup', handleUp)
    document.addEventListener('pointercancel', handleCancel)
    activeResizeCleanupRef.current = cleanupResize
  }

  return { height, resizing, panelRef, handleResizeStart }
}

/** Leave a useful preview area even when the entire file pane is narrow. */
export function fileTreeWidthBounds(containerWidth: number) {
  const available = containerWidth > 0 ? containerWidth : 960
  const max = Math.max(0, Math.min(480, available - Math.min(240, available * 0.55) - 8))
  return { min: Math.min(160, available * 0.25, max), max }
}

/** Trailing file tree uses the same captured-pointer/rAF pattern as the bottom panel.
 * Only the width is written during drag; the editor is not rerendered on every move. */
export function useResizableFileTree() {
  const [preferredWidth, setPreferredWidth] = useState(240)
  const [containerWidth, setContainerWidth] = useState(0)
  const [resizing, setResizing] = useState(false)
  const containerRef = useRef<HTMLDivElement>(null)
  const paneRef = useRef<HTMLDivElement>(null)
  const separatorRef = useRef<HTMLDivElement>(null)
  const cleanupRef = useRef<(() => void) | null>(null)
  const frameRef = useRef<number | null>(null)
  const bounds = fileTreeWidthBounds(containerWidth)
  const width = clamp(preferredWidth, bounds.min, bounds.max)

  useLayoutEffect(() => {
    const container = containerRef.current
    if (!container) return
    const measure = () => setContainerWidth(container.getBoundingClientRect().width)
    measure()
    if (typeof ResizeObserver === 'undefined') return
    const observer = new ResizeObserver(measure)
    observer.observe(container)
    return () => observer.disconnect()
  }, [])
  useEffect(() => () => cleanupRef.current?.(), [])

  const writeWidth = (value: number) => {
    if (paneRef.current) paneRef.current.style.width = `${value}px`
    separatorRef.current?.setAttribute('aria-valuenow', String(Math.round(value)))
  }
  const currentBounds = () =>
    fileTreeWidthBounds(containerRef.current?.getBoundingClientRect().width ?? 0)
  const handleResizeStart = (event: PointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) return
    event.preventDefault()
    cleanupRef.current?.()
    const handle = event.currentTarget
    handle.focus()
    try {
      handle.setPointerCapture?.(event.pointerId)
    } catch {
      /* synthetic/native verification */
    }
    const startX = event.clientX
    const startWidth = width
    let nextWidth = width
    const cursor = document.body.style.cursor
    const userSelect = document.body.style.userSelect
    const move = (pointer: globalThis.PointerEvent) => {
      const limits = currentBounds()
      nextWidth = clamp(startWidth + startX - pointer.clientX, limits.min, limits.max)
      if (frameRef.current !== null) return
      frameRef.current = window.requestAnimationFrame(() => {
        frameRef.current = null
        writeWidth(nextWidth)
      })
    }
    const cleanup = () => {
      document.removeEventListener('pointermove', move)
      document.removeEventListener('pointerup', finish)
      document.removeEventListener('pointercancel', finish)
      window.removeEventListener('blur', finish)
      if (frameRef.current !== null) window.cancelAnimationFrame(frameRef.current)
      frameRef.current = null
      if (handle.hasPointerCapture?.(event.pointerId)) handle.releasePointerCapture(event.pointerId)
      document.body.style.cursor = cursor
      document.body.style.userSelect = userSelect
      cleanupRef.current = null
    }
    const finish = () => {
      cleanup()
      const limits = currentBounds()
      writeWidth(clamp(nextWidth, limits.min, limits.max))
      setPreferredWidth(nextWidth)
      setResizing(false)
    }
    document.body.style.cursor = 'col-resize'
    document.body.style.userSelect = 'none'
    document.addEventListener('pointermove', move)
    document.addEventListener('pointerup', finish)
    document.addEventListener('pointercancel', finish)
    window.addEventListener('blur', finish)
    cleanupRef.current = cleanup
    setResizing(true)
  }
  const handleResizeKey = (event: React.KeyboardEvent<HTMLDivElement>) => {
    const limits = currentBounds()
    const next =
      event.key === 'Home'
        ? limits.min
        : event.key === 'End'
          ? limits.max
          : event.key === 'ArrowLeft'
            ? width + 16
            : event.key === 'ArrowRight'
              ? width - 16
              : null
    if (next === null) return
    event.preventDefault()
    setPreferredWidth(clamp(next, limits.min, limits.max))
  }
  return {
    width,
    bounds,
    resizing,
    containerRef,
    paneRef,
    separatorRef,
    handleResizeStart,
    handleResizeKey,
  }
}
