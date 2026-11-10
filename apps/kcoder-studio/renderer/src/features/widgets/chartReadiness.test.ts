import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import { createWidgetDrawingReadiness } from './chart-readiness.js'

let canvas: HTMLCanvasElement
let plugins: Array<{ afterRender: (chart: unknown) => void }>
let binding: unknown
let painted: boolean
let layoutVisible: boolean
const Chart = {
  register(plugin: { afterRender: (chart: unknown) => void }) { plugins.push(plugin) },
  getChart() { return binding },
}
beforeEach(() => {
  vi.useFakeTimers()
  plugins = []; binding = undefined; painted = true; layoutVisible = true
  document.body.innerHTML = '<main><canvas width="600" height="320"></canvas></main>'
  canvas = document.querySelector('canvas')!
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => setTimeout(() => callback(performance.now()), 16))
  vi.stubGlobal('cancelAnimationFrame', clearTimeout)
  vi.spyOn(Element.prototype, 'getBoundingClientRect').mockImplementation(() => ({ width: layoutVisible ? 600 : 0, height: layoutVisible ? 320 : 0 } as DOMRect))
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue({ clearRect() {}, drawImage() {}, getImageData: () => ({ data: new Uint8ClampedArray([0, 0, 0, painted ? 255 : 0]) }) } as unknown as CanvasRenderingContext2D)
})
afterEach(() => { vi.clearAllTimers(); vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllGlobals() })
function bind(data: unknown[] = [2, 5], draw = true) {
  binding = { canvas, data: { datasets: [{ data }] }, getDatasetMeta: () => ({ vScale: { axis: 'y' }, _parsed: data.map(y => ({ y })), data: [] }) }
  painted = draw
}
async function result(setup: () => void) {
  const readiness = createWidgetDrawingReadiness({ root: document.querySelector('main')!, Chart, required: true })
  setup()
  const pending = readiness.waitUntilReady()
  await vi.runAllTimersAsync()
  return pending
}
test.each(['physical', 'layout'])('a %s zero canvas never reports a drawing', async kind => {
  expect(await result(() => { bind(); if (kind === 'physical') canvas.width = 0; else layoutVisible = false })).toBe(false)
})
test('an unbound canvas is unconfirmed after the finite wait', async () => {
  expect(await result(() => {})).toBe(false)
  expect(performance.now()).toBeLessThan(2100)
})
test('binding alone is insufficient without a completed Chart drawing', async () => {
  expect(await result(() => bind([2, 5], false))).toBe(false)
})
test('a delayed binding and actual nonempty drawing can become ready inside the bound', async () => {
  expect(await result(() => { setTimeout(() => bind(), 400) })).toBe(true)
})
test('nonempty data with no bitmap drawing remains unconfirmed', async () => {
  expect(await result(() => { bind(); painted = false })).toBe(false)
})
test('legitimate missing data gets a readable empty state without coercing nulls', async () => {
  const data = [null, null]
  expect(await result(() => { bind(data); painted = false })).toBe(true)
  expect(document.querySelector('[data-widget-empty-chart]')).toHaveTextContent('No chart data to display')
  expect(data).toEqual([null, null])
})
