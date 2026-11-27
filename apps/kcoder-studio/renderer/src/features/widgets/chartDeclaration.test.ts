import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import runtime from './sandbox-runtime.js?raw'
import { createWidgetDrawingReadiness } from './chart-readiness.js'

type ChartConfiguration = { type?: string; data: { datasets: unknown[] }; options?: unknown }
type Receipt = { type: string; payload: { message?: string } }
let configurations: ChartConfiguration[]
let postMessage: ReturnType<typeof vi.spyOn>
let listeners: ReturnType<typeof vi.spyOn>

beforeEach(() => {
  vi.useFakeTimers()
  configurations = []
  document.body.innerHTML = '<main id="widget-root"></main>'
  class RecordingChart {
    static defaults = { font: {} }
    static plugin: { afterRender: (chart: RecordingChart) => void }
    static bound = new WeakMap<HTMLCanvasElement, RecordingChart>()
    static register(plugin: typeof RecordingChart.plugin) { RecordingChart.plugin = plugin }
    static getChart(canvas: HTMLCanvasElement) { return RecordingChart.bound.get(canvas) }
    canvas: HTMLCanvasElement
    data: ChartConfiguration['data']
    constructor(canvas: HTMLCanvasElement, configuration: ChartConfiguration) {
      this.canvas = canvas; this.data = configuration.data
      RecordingChart.bound.set(canvas, this)
      configurations.push(configuration)
      RecordingChart.plugin?.afterRender(this)
    }
    getDatasetMeta(index: number) { return { _parsed: (this.data.datasets[index] as { data: unknown[] }).data, data: [], vScale: undefined } }
    destroy() {}
    update() {}
  }
  vi.stubGlobal('Chart', RecordingChart)
  vi.stubGlobal('createWidgetDrawingReadiness', createWidgetDrawingReadiness)
  vi.spyOn(Element.prototype, 'getBoundingClientRect').mockReturnValue({ width: 600, height: 320 } as DOMRect)
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue({ clearRect() {}, drawImage() {}, getImageData: () => ({ data: new Uint8ClampedArray([0, 0, 0, 255]) }) } as unknown as CanvasRenderingContext2D)
  vi.stubGlobal(
    'ResizeObserver',
    class {
      observe() {}
      disconnect() {}
    }
  )
  postMessage = vi.spyOn(window.parent, 'postMessage').mockImplementation(() => {})
  listeners = vi.spyOn(window, 'addEventListener')
  window.eval(runtime)
})

afterEach(() => {
  for (const [type, listener] of listeners.mock.calls)
    window.removeEventListener(type, listener as EventListener)
  vi.clearAllTimers()
  vi.useRealTimers()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

async function render(raw: string) {
  window.dispatchEvent(
    new MessageEvent('message', {
      source: window.parent,
      origin: 'https://owned-parent.invalid',
      data: {
        protocol: 'kcoder-widget-host',
        version: 1,
        type: 'init',
        token: 'chart-unit-owned-mount-token',
        widgetId: 'chart-unit',
        revision: 1,
        executionMode: 'managed',
        title: 'Chart declaration',
        source: `<script type="application/json" data-kcoder-chart>${raw.replace(/</g, '\\u003c')}</script>`,
        state: {},
        theme: { locale: 'en', colorScheme: 'light', fontFamily: 'system-ui', fontSize: 'inherit' },
      },
    })
  )
  await vi.runAllTimersAsync()
  const receipts = postMessage.mock.calls.map(([value]) => value as Receipt)
  return {
    error: receipts.find(receipt => receipt.type === 'error')?.payload.message,
    ready: receipts.some(receipt => receipt.type === 'ready'),
  }
}

const configuration = (data: unknown[], type: string | undefined = 'bar') => ({
  type,
  data: { labels: ['A', 'B'], datasets: [{ data }] },
})

describe('the managed sandbox Chart.js declaration boundary', () => {
  it('preserves dataset-only mixed types without inventing a root type', async () => {
    const data = {
      labels: ['Q1', 'Q2'],
      datasets: [
        { type: 'bar', data: [128, 156], yAxisID: 'revenue' },
        { type: 'line', data: [8, 21], yAxisID: 'growth' },
      ],
    }
    expect(
      await render(JSON.stringify({ data, options: { scales: { growth: { position: 'right' } } } }))
    ).toEqual({ error: undefined, ready: true })
    expect(configurations).toHaveLength(1)
    expect(Object.hasOwn(configurations[0], 'type')).toBe(false)
    expect(configurations[0].data).toEqual(data)
    expect(document.querySelector('table')?.textContent).toContain('128')
  })

  it.each(['bar', 'line', 'pie', 'doughnut', 'scatter', 'radar', 'bubble', 'polarArea'])(
    'keeps the registered %s root type',
    async type => {
      expect((await render(JSON.stringify(configuration([2, 3], type)))).error).toBeUndefined()
      expect(configurations[0].type).toBe(type)
    }
  )

  it('keeps skipped values, tuples and custom nested point objects intact', async () => {
    const data = [null, [10, 20], { category: 'Sales', nested: { value: 1500 }, highlighted: true }]
    expect((await render(JSON.stringify(configuration(data)))).error).toBeUndefined()
    expect(configurations[0].data.datasets).toEqual([{ data }])
  })

  it.each([
    ['null', '/', 'invalid_chart_config'],
    ['[]', '/', 'invalid_chart_config'],
    [JSON.stringify({ config: configuration([2]) }), '/data', 'invalid_chart_data'],
    [JSON.stringify({ type: 'bar', data: null }), '/data', 'invalid_chart_data'],
    [JSON.stringify({ type: 'bar', data: [] }), '/data', 'invalid_chart_data'],
    [
      JSON.stringify({ type: 'bar', data: { datasets: null } }),
      '/data/datasets',
      'invalid_chart_datasets',
    ],
    [
      JSON.stringify({ type: 'bar', data: { datasets: [null] } }),
      '/data/datasets/0',
      'invalid_chart_dataset',
    ],
    [
      JSON.stringify({ type: 'bar', data: { datasets: [[]] } }),
      '/data/datasets/0',
      'invalid_chart_dataset',
    ],
    [JSON.stringify({ type: 'area', data: { datasets: [] } }), '/type', 'unsupported_chart_type'],
    [JSON.stringify({ type: null, data: { datasets: [] } }), '/type', 'unsupported_chart_type'],
    [
      JSON.stringify({ data: { datasets: [{ data: [1] }] } }),
      '/data/datasets/0/type',
      'missing_chart_type',
    ],
    [
      JSON.stringify({ type: 'bar', data: { datasets: [{ type: 'unknown', data: [1] }] } }),
      '/data/datasets/0/type',
      'unsupported_dataset_type',
    ],
    [
      JSON.stringify({ type: 'bar', data: { datasets: [{ data: {} }] } }),
      '/data/datasets/0/data',
      'invalid_dataset_data',
    ],
    [
      JSON.stringify(configuration(['not-a-number'])),
      '/data/datasets/0/data/0',
      'invalid_chart_point',
    ],
    [
      JSON.stringify({ ...configuration([1]), options: 'wrong' }),
      '/options',
      'invalid_chart_options',
    ],
    [
      JSON.stringify({ type: 'bar', data: { labels: 'wrong', datasets: [] } }),
      '/data/labels',
      'invalid_chart_labels',
    ],
  ])('reports %s at %s with %s before creating a canvas', async (raw, pointer, reason) => {
    const result = await render(raw)
    expect(result.error).toContain(`invalid_widget: ${pointer} (${reason})`)
    expect(result.ready).toBe(false)
    expect(configurations).toHaveLength(0)
    expect(document.querySelectorAll('canvas, table')).toHaveLength(0)
  })

  it('classifies malformed JSON separately', async () => {
    expect((await render('{')).error).toContain('invalid_widget: / (invalid_chart_json)')
    expect(configurations).toHaveLength(0)
  })

  it('names the nested nonfinite value rather than coercing it to a gap', async () => {
    const result = await render(
      '{"type":"bar","data":{"datasets":[{"data":[{"nested":{"value":1e309}}]}]},"options":{"parsing":{"yAxisKey":"nested.value"}}}'
    )
    expect(result.error).toContain('/data/datasets/0/data/0/nested/value (nonfinite_chart_value)')
    expect(configurations).toHaveLength(0)
  })

  it('allows exactly 32 datasets and keeps their data', async () => {
    const datasets = Array.from({ length: 32 }, () => ({ data: [1] }))
    expect(
      (await render(JSON.stringify({ type: 'bar', data: { datasets } }))).error
    ).toBeUndefined()
    expect(configurations[0].data.datasets).toHaveLength(32)
  })

  it('classifies excess datasets as a quota failure', async () => {
    const datasets = Array.from({ length: 33 }, () => ({ data: [1] }))
    expect((await render(JSON.stringify({ type: 'bar', data: { datasets } }))).error).toContain(
      'widget_quota: /data/datasets (dataset_limit)'
    )
    expect(configurations).toHaveLength(0)
  })

  it('allows exactly 10000 points and bounds only the data-table preview', async () => {
    expect(
      (
        await render(
          JSON.stringify({ type: 'bar', data: { datasets: [{ data: Array(10000).fill(1) }] } })
        )
      ).error
    ).toBeUndefined()
    expect((configurations[0].data.datasets[0] as { data: unknown[] }).data).toHaveLength(10000)
    expect(document.querySelectorAll('tbody tr')).toHaveLength(100)
  })

  it('counts points across datasets before constructing Chart.js', async () => {
    const datasets = [{ data: Array(5000).fill(1) }, { data: Array(5001).fill(2) }]
    expect((await render(JSON.stringify({ type: 'bar', data: { datasets } }))).error).toContain(
      'widget_quota: /data/datasets (point_limit)'
    )
    expect(configurations).toHaveLength(0)
  })
})
