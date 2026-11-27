import { useLayoutEffect, useRef, useState, type RefObject } from 'react'

function fittedDensity(toolbar: HTMLDivElement) {
  const density = Number(toolbar.dataset.density)
  if (density >= 4) return density
  const actions = toolbar.querySelector<HTMLElement>('[data-testid="composer-toolbar-actions"]')
  const models = toolbar.querySelector<HTMLElement>(
    '[data-testid="composer-toolbar-model-controls"]'
  )
  if (!actions || !models) return density
  const gap = parseFloat(getComputedStyle(toolbar).columnGap) || 0
  const needed = actions.getBoundingClientRect().width + models.getBoundingClientRect().width + gap
  return needed > toolbar.getBoundingClientRect().width + 1 ? density + 1 : density
}

// Labels -> icons -> secondary actions folded -> all optional actions folded -> stacked rows.
export function useToolbarDensity(ref: RefObject<HTMLDivElement | null>) {
  const [density, setDensity] = useState(0)
  const previousWidth = useRef(0)
  useLayoutEffect(() => {
    const toolbar = ref.current
    if (!toolbar || typeof ResizeObserver === 'undefined') return
    const observer = new ResizeObserver(() => {
      const width = toolbar.getBoundingClientRect().width
      const resized = width !== previousWidth.current
      previousWidth.current = width
      setDensity(resized && Number(toolbar.dataset.density) > 0 ? 0 : fittedDensity(toolbar))
    })
    observer.observe(toolbar)
    for (const child of toolbar.children) observer.observe(child)
    return () => observer.disconnect()
  }, [ref])
  useLayoutEffect(() => {
    if (ref.current) setDensity(fittedDensity(ref.current))
  }, [density, ref])
  return density
}
