/** Embedded as a private closure in both fixed widget documents. */
export function createWidgetDrawingReadiness({ root, Chart, required, locale = () => 'en', timeoutMs = 2000 }) {
  const samples = new WeakMap()
  const labels = new WeakMap()
  const getChart = Chart?.getChart?.bind(Chart)
  const getContext = HTMLCanvasElement.prototype.getContext
  const rect = Element.prototype.getBoundingClientRect
  const width = Object.getOwnPropertyDescriptor(HTMLCanvasElement.prototype, 'width').get
  const height = Object.getOwnPropertyDescriptor(HTMLCanvasElement.prototype, 'height').get
  const requestFrame = requestAnimationFrame
  const cancelFrame = cancelAnimationFrame
  const schedule = setTimeout
  const unschedule = clearTimeout
  const now = performance.now.bind(performance)

  const hasVisibleValues = chart => chart.data.datasets.some((dataset, index) => {
    if (chart.isDatasetVisible?.(index) === false) return false
    const meta = chart.getDatasetMeta(index)
    const axis = meta.vScale?.axis
    return (meta._parsed ?? dataset.data).some((point, pointIndex) => {
      if (meta.data?.[pointIndex]?.skip === true || point == null) return false
      if (typeof point === 'number') return Number.isFinite(point)
      if (axis) return typeof point[axis] === 'number' && Number.isFinite(point[axis])
      return typeof point.x === 'number' && Number.isFinite(point.x) && typeof point.y === 'number' && Number.isFinite(point.y)
    })
  })
  const painted = canvas => {
    let sample = samples.get(canvas)
    if (!sample) {
      sample = document.createElement('canvas'); sample.width = 64; sample.height = 64
      samples.set(canvas, sample)
    }
    try {
      const context = getContext.call(sample, '2d', { willReadFrequently: true })
      context.clearRect(0, 0, 64, 64); context.drawImage(canvas, 0, 0, 64, 64)
      const pixels = context.getImageData(0, 0, 64, 64).data
      for (let alpha = 3; alpha < pixels.length; alpha += 4) if (pixels[alpha] > 0) return true
    } catch { /* An unreadable bitmap is unconfirmed, not a fabricated drawing failure. */ }
    return false
  }
  const confirmed = () => {
    if (!required) return true
    const canvases = [...root.querySelectorAll('canvas')]
    if (!canvases.length || !getChart) return false
    return canvases.every(canvas => {
      const box = rect.call(canvas)
      const chart = getChart(canvas)
      if (!canvas.isConnected || width.call(canvas) <= 0 || height.call(canvas) <= 0 || box.width <= 0 || box.height <= 0 || !chart || chart.canvas !== canvas) return false
      if (hasVisibleValues(chart)) return painted(canvas)
      if (!labels.has(canvas)) {
        const label = document.createElement('p'); label.setAttribute('role', 'status'); label.dataset.widgetEmptyChart = 'true'
        label.textContent = locale().startsWith('zh') ? '暂无可显示的图表数据' : 'No chart data to display'
        ;(canvas.closest('figure') ?? canvas.parentElement ?? root).append(label)
        labels.set(canvas, label)
      }
      return true
    })
  }
  const frameOrTimeout = () => new Promise(resolve => {
    const frame = requestFrame(() => { unschedule(timer); resolve(true) })
    const timer = schedule(() => { cancelFrame(frame); resolve(false) }, 50)
  })
  return {
    async waitUntilReady() {
      const started = now()
      while (now() - started < timeoutMs) {
        if (await frameOrTimeout()) {
          try { if (confirmed()) return true } catch { /* Binding and geometry can still be pending. */ }
        }
      }
      return false
    },
  }
}
