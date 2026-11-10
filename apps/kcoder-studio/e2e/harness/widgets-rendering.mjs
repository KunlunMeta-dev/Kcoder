import assert from 'node:assert/strict'
import http from 'node:http'
import { readFile, mkdir } from 'node:fs/promises'
import path from 'node:path'
import { startChromium } from './chromium.mjs'
import { appRoot } from './run-context.mjs'
import { createRequire } from 'node:module'
const { build } = createRequire(new URL('../../renderer/package.json', import.meta.url))('vite')

/** Actual Chromium acceptance for the fixed opaque document, independent of React. */
export async function verifyWidgetSandbox(context, { executablePath } = {}) {
  const renderer = path.join(appRoot, 'renderer')
  const here = path.join(renderer, 'src/features/widgets')
  const artifacts = context.artifactsDir
  const html = await readFile(path.join(renderer, 'public/widget-sandbox/host-v1.html'))
  const policy = JSON.parse(await readFile(path.join(renderer, 'public/widget-sandbox/policy-v1.json')))
  const manifest = JSON.parse(await readFile(path.join(here, 'resources/manifest.json')))
  const librarySources = {}
  for (const asset of manifest.filter(asset => asset.file.endsWith('.js'))) {
    librarySources[asset.id === 'chart_js' ? 'chartjs' : asset.id] = await readFile(path.join(here, 'resources', asset.file), 'utf8')
  }
  const topology = JSON.parse(await readFile(path.join(here, 'resources/countries-110m.json'), 'utf8'))
  const hashBuild = await build({ configFile: false, root: renderer, logLevel: 'error', build: { write: false, minify: false, lib: { entry: path.join(here, 'contentHash.ts'), name: 'WidgetHashLibrary', formats: ['iife'] } } })
  const hashSource = (Array.isArray(hashBuild) ? hashBuild[0] : hashBuild).output.find(item => item.type === 'chunk').code
  const server = http.createServer((request, response) => {
    if (request.url === '/sandbox') {
      response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Content-Security-Policy': policy.csp, 'Cache-Control': 'no-store' }); response.end(html)
    } else if (request.url === '/hash.js') {
      response.writeHead(200, { 'Content-Type': 'application/javascript' }); response.end(hashSource)
    } else if (request.url === '/') {
      response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }); response.end('<!doctype html><html><body><iframe title="fixture" sandbox="allow-scripts" src="/sandbox" style="width:100%;max-width:900px;height:560px;border:0;display:block"></iframe></body></html>')
    } else { response.writeHead(404); response.end() }
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  const origin = `http://127.0.0.1:${server.address().port}`
  context.registerPort('widget-rendering-http', server.address().port)
  context.addCleanup('widget-rendering HTTP', () => new Promise(resolve => server.close(resolve)))
  let browser
  let chromium
  const results = []
  try {
    chromium = await startChromium(context, { executablePath, label: 'widget-rendering-chromium', portLabel: 'widget-rendering-cdp' })
    browser = chromium.browser
    const page = await chromium.newPage({ viewport: { width: 1100, height: 760 } })
    const forbiddenRequests = []
    page.on('request', request => { if (!request.url().startsWith(origin)) forbiddenRequests.push(request.url()) })
    if (artifacts) await mkdir(artifacts, { recursive: true })
    await page.goto(origin)
    await page.addScriptTag({ url: `${origin}/hash.js` })
    const browserHashes = await page.evaluate(async () => {
      Object.defineProperty(globalThis.crypto, 'subtle', { configurable: true, value: undefined })
      return Promise.all(['', 'abc', '中文与emoji🙂'].map(source => globalThis.WidgetHashLibrary.widgetContentSha256(new TextEncoder().encode(source))))
    })
    assert.deepEqual(browserHashes, ['e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855', 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad', '902ee83bcc426f28aaa4c94683bbac405d3ead986baa6b0145ff0d077f8f808f'])
    results.push('real-browser-sha256-fallback-without-subtlecrypto')
    const run = async (source, title, extra = {}) => {
      await page.goto(origin)
      await page.waitForFunction(() => document.querySelector('iframe')?.contentWindow)
      const frame = page.frames().find(frame => frame.url() === `${origin}/sandbox`)
      await frame.waitForSelector('#widget-root')
      await page.evaluate(({ source, title, librarySources, topology, extra }) => {
        globalThis.receipts = []
        globalThis.widgetListener && removeEventListener('message', globalThis.widgetListener)
        globalThis.widgetListener = event => {
          const iframe = document.querySelector('iframe')
          if (event.source !== iframe.contentWindow) return
          globalThis.receipts.push(event.data)
          if (event.data.type === 'resize' && Number.isFinite(event.data.payload.height)) {
            iframe.style.height = Math.max(120, Math.ceil(event.data.payload.height)) + 'px'
          }
        }
        addEventListener('message', globalThis.widgetListener)
        document.querySelector('iframe').contentWindow.postMessage({ protocol: 'kcoder-widget-host', version: 1, type: 'init', token: 'test-mount-token-9876543210', widgetId: 'test-widget', revision: 1,
          executionMode: 'managed', title, source, librarySources, topology, theme: { locale: 'zh-CN', colorScheme: 'light', foreground: '#202020', background: '#ffffff', muted: '#666666', border: '#dddddd', primary: '#3589df', destructive: '#e84a4a', success: '#228850', fontFamily: 'system-ui', fontSize: '14px', reducedMotion: true }, ...extra }, '*')
      }, { source, title, librarySources, topology, extra })
      await page.waitForFunction(() => globalThis.receipts.some(item => ['ready', 'error'].includes(item.type)))
      const failure = await page.evaluate(() => globalThis.receipts.find(item => item.type === 'error'))
      if (failure && !extra.expectError) {
        await context.writeArtifactJson('widget-rendering-failure.json', {
          title, source: source.slice(0, 8192), sourceBytes: Buffer.byteLength(source),
          error: failure.payload.message,
          canvasCount: await frame.locator('canvas').count(),
          tableCount: await frame.locator('table').count(),
          passedBeforeFailure: results,
        })
        if (artifacts) await page.locator('iframe').screenshot({ path: path.join(artifacts, 'widget-rendering-failure.png') })
        throw new Error(failure.payload.message)
      }
      return frame
    }
    const overview = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 840 240" role="img"><title>六种可视化类型</title><desc>图示、图表、地图、交互组件、界面原型和插画</desc><g data-kcoder-prompt="讲解图示" aria-label="图示"><rect x="10" y="10" width="250" height="90" rx="12" fill="var(--background)" stroke="var(--border)"/><text x="90" y="60" fill="var(--foreground)">图示 Diagram</text></g><text x="360" y="60">图表 Chart</text><text x="650" y="60">地图 Map</text><text x="90" y="190">交互组件</text><text x="360" y="190">界面原型</text><text x="650" y="190">插画演示</text></svg>'
    let frame = await run(overview, '六种可视化类型')
    assert.equal(await frame.locator('svg').count(), 1)
    await frame.locator('[data-kcoder-prompt]').focus()
    await page.keyboard.press('Enter')
    await page.waitForFunction(() => globalThis.receipts.some(item => item.type === 'sendPrompt' && item.payload.text === '讲解图示'))
    assert.equal(await frame.evaluate(() => { try { return parent.document.body.innerText } catch { return 'blocked' } }), 'blocked')
    assert.equal(await frame.evaluate(() => { try { return document.cookie } catch { return 'blocked' } }), 'blocked')
    if (artifacts) await page.locator('iframe').screenshot({ path: path.join(artifacts, 'overview.png') })
    results.push('svg-keyboard-prompt-and-opaque-parent-cookie')

    const chart = { type: 'bar', data: { labels: ['Q1', 'Q2', 'Q3', 'Q4'], datasets: [{ label: '季度营收（万元）', data: [128, 156, 142, 189], backgroundColor: '#3589df', yAxisID: 'revenue', order: 2 }, { type: 'line', label: '同比增速（%）', data: [8, 21, -9, 33], borderColor: '#e84a4a', borderDash: [6, 4], pointStyle: 'rect', yAxisID: 'growth', order: 1 }] }, options: { scales: { revenue: { position: 'left', beginAtZero: true }, growth: { position: 'right', min: -10, max: 35, grid: { drawOnChartArea: false } } } } }
    frame = await run(`<script type="application/json" data-kcoder-chart>${JSON.stringify(chart)}</script>`, '季度营收与同比增速')
    assert.equal(await frame.locator('canvas').count(), 1)
    assert.equal(await frame.evaluate(() => globalThis.Chart.version), '4.5.1')
    const actualChart = await frame.evaluate(() => { const chart = globalThis.Chart.getChart(document.querySelector('canvas')); return { revenue: chart.data.datasets[0].data, growth: chart.data.datasets[1].data, axis: chart.data.datasets[1].yAxisID, position: chart.scales.growth.position } })
    assert.deepEqual(actualChart, { revenue: [128, 156, 142, 189], growth: [8, 21, -9, 33], axis: 'growth', position: 'right' })
    await frame.locator('summary').click()
    assert.match(await frame.locator('table').innerText(), /Q3\s+142\s+-9/)
    if (artifacts) await page.locator('iframe').screenshot({ path: path.join(artifacts, 'revenue.png') })
    results.push('real-chartjs-mixed-dual-axis-and-data-table')

    // Chart.js supports mixed charts through dataset types without a root type.
    const { type: omittedRootType, ...mixedChart } = chart
    mixedChart.data = {
      ...chart.data,
      datasets: chart.data.datasets.map(dataset => ({ ...dataset, type: dataset.type ?? omittedRootType })),
    }
    frame = await run(`<script type="application/json" data-kcoder-chart>${JSON.stringify(mixedChart)}</script>`, '仅数据系列声明类型的混合图')
    const mixedActual = await frame.evaluate(() => {
      const canvas = document.querySelector('canvas')
      const chart = globalThis.Chart.getChart(canvas)
      return {
        rootTypeAbsent: !Object.hasOwn(chart.config._config, 'type'),
        series: chart.data.datasets.map((dataset, index) => ({ type: chart.getDatasetMeta(index).type, values: dataset.data, axis: dataset.yAxisID })),
        canvas: { width: canvas.width, height: canvas.height },
      }
    })
    assert.equal(mixedActual.rootTypeAbsent, true)
    assert.deepEqual(mixedActual.series, [{ type: 'bar', values: [128, 156, 142, 189], axis: 'revenue' }, { type: 'line', values: [8, 21, -9, 33], axis: 'growth' }])
    assert.ok(mixedActual.canvas.width > 0 && mixedActual.canvas.height > 0)
    await frame.locator('summary').click()
    assert.match(await frame.locator('table').innerText(), /Q3\s+142\s+-9/)
    await context.writeArtifactJson('dataset-only-mixed-chart.json', mixedActual)
    if (artifacts) await page.locator('iframe').screenshot({ path: path.join(artifacts, 'dataset-only-mixed-chart.png') })
    results.push('real-chartjs-dataset-only-mixed-without-root-type-and-data-table')

    await frame.evaluate(() => { globalThis.originalCanvas = document.querySelector('canvas') })
    await page.evaluate(() => document.querySelector('iframe').contentWindow.postMessage({ protocol: 'kcoder-widget-host', version: 1, type: 'theme', token: 'test-mount-token-9876543210', widgetId: 'test-widget', revision: 1, theme: { locale: 'en', colorScheme: 'dark', foreground: '#eeeeee', background: '#181818', muted: '#aaaaaa', border: '#444444', primary: '#77aaff', destructive: '#ff7777', success: '#66cc88', fontFamily: 'system-ui', fontSize: '16px', reducedMotion: true } }, '*'))
    await frame.waitForFunction(() => document.documentElement.lang === 'en')
    assert.equal(await frame.evaluate(() => document.querySelector('canvas') === globalThis.originalCanvas), true)
    assert.equal(await frame.evaluate(() => getComputedStyle(document.body).backgroundColor), 'rgb(24, 24, 24)')
    assert.equal(await frame.evaluate(() => globalThis.Chart.defaults.font.size), 16)
    results.push('theme-font-locale-update-without-canvas-remount')

    for (const type of ['bar', 'line', 'pie', 'doughnut', 'scatter', 'radar', 'bubble', 'polarArea']) {
      const data = type === 'scatter' ? [{ x: 1, y: 2 }, { x: 2, y: 3 }] : type === 'bubble' ? [{ x: 1, y: 2, r: 6 }, { x: 2, y: 3, r: 9 }] : [2, 3]
      frame = await run(`<script type="application/json" data-kcoder-chart>${JSON.stringify({ type, data: { labels: ['A', 'B'], datasets: [{ label: type, data }] } })}</script>`, type)
      assert.equal(await frame.locator('canvas').count(), 1, type)
      assert.equal(await page.evaluate(() => globalThis.receipts.some(item => item.type === 'error')), false, type)
    }
    results.push('all-eight-registered-chart-kinds')

    const skipped = { type: 'line', data: { labels: ['A', 'B', 'C'], datasets: [{ data: [2, null, 4] }] } }
    frame = await run(`<script type="application/json" data-kcoder-chart>${JSON.stringify(skipped)}</script>`, '缺失值保持空缺')
    assert.deepEqual(await frame.evaluate(() => {
      const chart = globalThis.Chart.getChart(document.querySelector('canvas'))
      return { data: chart.data.datasets[0].data, skipped: chart.getDatasetMeta(0).data[1].skip }
    }), { data: [2, null, 4], skipped: true })
    const tuples = { type: 'scatter', data: { datasets: [{ data: [[1, 2], [2, null], [3, 4]] }] } }
    frame = await run(`<script type="application/json" data-kcoder-chart>${JSON.stringify(tuples)}</script>`, '二元坐标数组')
    assert.deepEqual(await frame.evaluate(() => {
      const chart = globalThis.Chart.getChart(document.querySelector('canvas'))
      return { data: chart.data.datasets[0].data, parsed: chart.getDatasetMeta(0)._parsed }
    }), { data: [[1, 2], [2, null], [3, 4]], parsed: [{ x: 1, y: 2 }, { x: 2, y: null }, { x: 3, y: 4 }] })
    const nestedPoints = { type: 'bar', data: { datasets: [{ data: [{ id: 'Sales', nested: { value: 1500 } }, { id: 'Purchases', nested: { value: 500 } }] }] }, options: { parsing: { xAxisKey: 'id', yAxisKey: 'nested.value' } } }
    frame = await run(`<script type="application/json" data-kcoder-chart>${JSON.stringify(nestedPoints)}</script>`, '嵌套对象坐标')
    assert.deepEqual(await frame.evaluate(() => {
      const chart = globalThis.Chart.getChart(document.querySelector('canvas'))
      return { data: chart.data.datasets[0].data, values: chart.getDatasetMeta(0)._parsed.map(item => item.y) }
    }), { data: nestedPoints.data.datasets[0].data, values: [1500, 500] })
    results.push('chart-null-gaps-tuples-and-custom-nested-points-preserved')

    const invalidCharts = [
      ['null', '/', 'invalid_chart_config', 'invalid_widget'],
      [JSON.stringify({ config: chart }), '/data', 'invalid_chart_data', 'invalid_widget'],
      [JSON.stringify({ type: 'bar', data: { datasets: [null] } }), '/data/datasets/0', 'invalid_chart_dataset', 'invalid_widget'],
      [JSON.stringify({ data: { datasets: [{ type: 'bar', data: [1] }, { data: [2] }] } }), '/data/datasets/1/type', 'missing_chart_type', 'invalid_widget'],
      [JSON.stringify({ type: 'area', data: { datasets: [] } }), '/type', 'unsupported_chart_type', 'invalid_widget'],
      [JSON.stringify({ type: 'bar', data: { datasets: [{ type: 'unknown', data: [1] }] } }), '/data/datasets/0/type', 'unsupported_dataset_type', 'invalid_widget'],
      [JSON.stringify({ type: 'bar', data: { datasets: [{ data: ['wrong'] }] } }), '/data/datasets/0/data/0', 'invalid_chart_point', 'invalid_widget'],
      ['{"type":"bar","data":{"datasets":[{"data":[{"nested":{"value":1e309}}]}]}}', '/data/datasets/0/data/0/nested/value', 'nonfinite_chart_value', 'invalid_widget'],
      [JSON.stringify({ type: 'bar', data: { datasets: Array.from({ length: 33 }, () => ({ data: [1] })) } }), '/data/datasets', 'dataset_limit', 'widget_quota'],
      [JSON.stringify({ type: 'bar', data: { datasets: [{ data: Array(5000).fill(1) }, { data: Array(5001).fill(2) }] } }), '/data/datasets', 'point_limit', 'widget_quota'],
    ]
    const diagnostics = []
    for (const [raw, pointer, reason, category] of invalidCharts) {
      frame = await run(`<script type="application/json" data-kcoder-chart>${raw}</script>`, `图表错误：${reason}`, { expectError: true })
      const message = await page.evaluate(() => globalThis.receipts.find(item => item.type === 'error')?.payload.message)
      assert.ok(message?.startsWith(`${category}: ${pointer} (${reason}):`), message)
      assert.equal(await page.evaluate(() => globalThis.receipts.some(item => item.type === 'ready')), false, reason)
      assert.equal(await frame.locator('canvas, table').count(), 0, reason)
      diagnostics.push({ pointer, reason, category, message })
    }
    await context.writeArtifactJson('chart-declaration-diagnostics.json', diagnostics)
    results.push('chart-shape-type-point-and-quota-errors-have-exact-pointers-without-false-ready')

    const compound = '<div id="savings" data-kcoder-recipe="compound-interest"><script type="application/json" data-kcoder-config>{"principal":560000,"annualRate":8.5,"years":7}</script></div>'
    frame = await run(compound, '复利试算器')
    const actual = Number(await frame.locator('output').nth(0).getAttribute('data-value'))
    assert.ok(Math.abs(actual - 991279.658373168) < 1e-6)
    if (artifacts) await page.locator('iframe').screenshot({ path: path.join(artifacts, 'compound.png') })
    await frame.locator('input[type=range]').nth(2).focus()
    await page.keyboard.press('ArrowRight')
    assert.equal(await frame.locator('input[type=number]').nth(2).inputValue(), '8')
    assert.ok(Math.abs(Number(await frame.locator('output').nth(0).getAttribute('data-value')) - 1075538.4293348873) < 1e-6)
    await frame.locator('input[type=number]').nth(0).fill('0')
    await frame.locator('input[type=number]').nth(0).press('Tab')
    assert.equal(await frame.locator('output').nth(2).innerText(), '0%')
    const state = await page.evaluate(() => globalThis.receipts.filter(item => item.type === 'state').at(-1).payload.state)
    frame = await run(compound, '复利试算器', { state })
    assert.equal(await frame.locator('input[type=number]').nth(2).inputValue(), '8')
    assert.equal(await frame.locator('input[type=number]').nth(0).inputValue(), '0')
    await frame.evaluate(() => { globalThis.originalYearsInput = document.querySelectorAll('input[type=number]')[2] })
    const englishTheme = { locale: 'en', colorScheme: 'light', foreground: '#202020', background: '#ffffff', muted: '#666666', border: '#dddddd', primary: '#3589df', destructive: '#e84a4a', success: '#228850', fontFamily: 'system-ui', fontSize: 'inherit', reducedMotion: true }
    await page.evaluate(theme => document.querySelector('iframe').contentWindow.postMessage({ protocol: 'kcoder-widget-host', version: 1, type: 'theme', token: 'test-mount-token-9876543210', widgetId: 'test-widget', revision: 1, theme }, '*'), englishTheme)
    await frame.getByRole('spinbutton', { name: 'Years', exact: true }).waitFor()
    assert.equal(await frame.evaluate(() => document.querySelectorAll('input[type=number]')[2] === globalThis.originalYearsInput), true)
    assert.equal(await frame.locator('input[type=number]').nth(2).inputValue(), '8')
    results.push('compound-independent-baseline-keyboard-input-and-json-restore')

    const mapSource = '<script id="world-map" type="application/json" data-kcoder-map>{"values":{"156":10,"840":20,"76":15,"36":18},"unit":" 示例值","markers":[{"label":"零度交点","longitude":0,"latitude":0},{"label":"赤道东经90度","longitude":90,"latitude":0}]}</script>'
    frame = await run(mapSource, '世界地图')
    assert.ok(await frame.locator('svg path').count() > 170)
    assert.match(await frame.locator('figcaption').innerText(), /Natural Earth.*2\.0\.2/)
    assert.match(await frame.locator('[data-map-legend]').innerText(), /10 示例值.*20 示例值.*无数据.*坐标标注/s)
    const countryColors = current => current.locator('svg path').evaluateAll(nodes => nodes
      .filter(node => /^(Brazil|Australia):/.test(node.querySelector('title')?.textContent || ''))
      .map(node => ({ title: node.querySelector('title').textContent, fill: node.getAttribute('fill'), opacity: node.getAttribute('fill-opacity') })))
    const compactColors = await countryColors(frame)
    assert.equal(compactColors.length, 2)
    assert.ok(compactColors.every(region => region.fill === 'var(--primary)' && Number(region.opacity) > 0.35))
    const compactRows = await frame.locator('table tr').evaluateAll(rows => rows.map(row => [...row.cells].map(cell => cell.textContent)))
    assert.ok(compactRows.some(row => row[0] === 'Brazil' && row[1] === '15 示例值'))
    assert.ok(compactRows.some(row => row[0] === 'Australia' && row[1] === '18 示例值'))
    const projectedMarkers = await frame.locator('[data-map-marker]').evaluateAll(markers => markers.map(marker => ({ longitude: Number(marker.dataset.longitude), latitude: Number(marker.dataset.latitude), x: Number(marker.querySelector('circle').getAttribute('cx')), y: Number(marker.querySelector('circle').getAttribute('cy')) })))
    assert.equal(projectedMarkers.length, 2)
    assert.deepEqual(projectedMarkers.map(marker => [marker.longitude, marker.latitude]), [[0, 0], [90, 0]])
    assert.ok(projectedMarkers.every(marker => marker.x >= 0 && marker.x <= 700 && marker.y >= 0 && marker.y <= 350))
    assert.ok(projectedMarkers[1].x > projectedMarkers[0].x)
    assert.ok(Math.abs(projectedMarkers[1].y - projectedMarkers[0].y) < 1e-6)
    assert.equal(await frame.locator('[data-map-zoom]').innerText(), '100%')
    await frame.locator('[data-map-action="in"]').click()
    assert.equal(await frame.locator('[data-map-zoom]').innerText(), '150%')
    const beforePan = await frame.locator('[data-map-plot]').getAttribute('transform')
    await frame.locator('svg').focus(); await page.keyboard.press('ArrowRight')
    assert.notEqual(await frame.locator('[data-map-plot]').getAttribute('transform'), beforePan)
    const mapState = await page.evaluate(() => globalThis.receipts.filter(item => item.type === 'state').at(-1).payload.state)
    frame = await run(mapSource, '世界地图', { state: mapState })
    assert.equal(await frame.locator('[data-map-zoom]').innerText(), '150%')
    for (let index = 0; index < 8; index += 1) await frame.locator('[data-map-action="in"]').click()
    assert.equal(await frame.locator('[data-map-zoom]').innerText(), '400%')
    await frame.locator('svg').focus(); await page.keyboard.press('-')
    assert.equal(await frame.locator('[data-map-zoom]').innerText(), '267%')
    await page.keyboard.press('0')
    assert.equal(await frame.locator('[data-map-zoom]').innerText(), '100%')
    await frame.locator('[data-map-action="in"]').click(); await frame.locator('[data-map-action="reset"]').click()
    assert.equal(await frame.locator('[data-map-zoom]').innerText(), '100%')
    await frame.locator('summary').click()
    assert.match(await frame.locator('table').innerText(), /零度交点\s+0, 0/)
    await frame.evaluate(() => { globalThis.originalMap = document.querySelector('svg') })
    await page.evaluate(theme => document.querySelector('iframe').contentWindow.postMessage({ protocol: 'kcoder-widget-host', version: 1, type: 'theme', token: 'test-mount-token-9876543210', widgetId: 'test-widget', revision: 1, theme }, '*'), englishTheme)
    await frame.getByRole('button', { name: 'Zoom in', exact: true }).waitFor()
    assert.match(await frame.locator('[data-map-legend]').innerText(), /No data.*Coordinate markers/s)
    assert.equal(await frame.evaluate(() => document.querySelector('svg') === globalThis.originalMap), true)
    assert.equal(await frame.locator('[data-map-zoom]').innerText(), '100%')
    for (const marker of [{ label: 'invalid longitude', longitude: 181, latitude: 0 }, { label: 'invalid latitude', longitude: 0, latitude: -91 }, { label: 'string coordinate', longitude: '0', latitude: 0 }]) {
      await run(`<script type="application/json" data-kcoder-map>${JSON.stringify({ markers: [marker] })}</script>`, '错误坐标', { expectError: true })
      assert.match(await page.evaluate(() => globalThis.receipts.filter(item => item.type === 'error').at(-1).payload.message), /markers\[0\].*longitude.*latitude/)
    }
    frame = await run(mapSource.replace('"76":15,"36":18', '"076":15,"036":18'), '补齐国家代码')
    assert.deepEqual(await countryColors(frame), compactColors)
    assert.equal(await frame.locator('[data-map-marker]').count(), 2)
    results.push('real-map-compact-and-padded-iso-ids-preserve-colors-values-and-markers')
    results.push('real-d3-topojson-map-bounded-zoom-keyboard-reset-state-legend-real-coordinate-validation')

    frame = await run('<section><h2>文档整理</h2><table><tbody><tr><td>会议纪要</td><td>待整理</td></tr></tbody></table><p data-kcoder-prompt="整理会议纪要">整理会议纪要 →</p></section>', '界面原型')
    assert.equal(await frame.getByRole('heading', { name: '文档整理' }).count(), 1)
    await frame.getByRole('button', { name: '整理会议纪要 →' }).click()
    await page.waitForFunction(() => globalThis.receipts.some(item => item.type === 'sendPrompt' && item.payload.text === '整理会议纪要'))
    const animationSource = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 600 120"><title>资料流转</title><style>@keyframes travel{from{transform:translateX(0)}to{transform:translateX(400px)}}.flow{animation:travel 4s linear infinite}</style><path d="M80 60H500" stroke="var(--border)"/><circle class="flow" cx="80" cy="60" r="8" fill="var(--primary)"/></svg>'
    frame = await run(animationSource, '插画动画')
    assert.equal(await frame.locator('.flow').evaluate(node => getComputedStyle(node).animationPlayState), 'paused')
    assert.equal(await frame.locator('[data-animation-control]').isDisabled(), true)
    const playingTheme = { ...englishTheme, reducedMotion: false }
    const setTheme = theme => page.evaluate(theme => document.querySelector('iframe').contentWindow.postMessage({ protocol: 'kcoder-widget-host', version: 1, type: 'theme', token: 'test-mount-token-9876543210', widgetId: 'test-widget', revision: 1, theme }, '*'), theme)
    await setTheme(playingTheme)
    await frame.getByRole('button', { name: 'Pause animation', exact: true }).waitFor()
    assert.equal(await frame.locator('[data-animation-control]').isDisabled(), false)
    assert.equal(await frame.evaluate(() => document.getElementById('widget-root').getAnimations({ subtree: true }).some(animation => animation.playState === 'running')), true)
    await frame.getByRole('button', { name: 'Pause animation', exact: true }).click()
    await frame.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))))
    const pausedTransform = await frame.locator('.flow').evaluate(node => getComputedStyle(node).transform)
    await page.waitForTimeout(100)
    assert.equal(await frame.locator('.flow').evaluate(node => getComputedStyle(node).transform), pausedTransform)
    assert.equal(await frame.evaluate(() => { const animations = document.getElementById('widget-root').getAnimations({ subtree: true }); return animations.length > 0 && animations.every(animation => animation.playState === 'paused') }), true)
    const playbackState = await page.evaluate(() => globalThis.receipts.filter(item => item.type === 'state').at(-1).payload.state)
    frame = await run(animationSource, '插画动画', { state: playbackState, theme: playingTheme })
    await frame.getByRole('button', { name: 'Play animation', exact: true }).waitFor()
    assert.equal(await frame.evaluate(() => { const animations = document.getElementById('widget-root').getAnimations({ subtree: true }); return animations.length > 0 && animations.every(animation => animation.playState === 'paused') }), true)
    await frame.getByRole('button', { name: 'Play animation', exact: true }).click()
    await setTheme(englishTheme)
    await frame.getByRole('button', { name: 'Reduced motion is on', exact: true }).waitFor()
    assert.equal(await frame.locator('[data-animation-control]').isDisabled(), true)
    assert.equal(await frame.locator('.flow').evaluate(node => getComputedStyle(node).animationPlayState), 'paused')
    await setTheme({ ...playingTheme, locale: 'zh-CN' })
    await frame.getByRole('button', { name: '暂停动画', exact: true }).waitFor()
    assert.equal(await frame.locator('[data-animation-control]').isDisabled(), false)
    results.push('prototype-draft-interaction-animation-play-pause-state-locale-reduced-motion-priority')

    frame = await run('<section><h2>完整流程图</h2><div style="height:1600px">长内容</div><details><summary>展开后续步骤</summary><div style="height:900px">后续步骤完整显示</div></details></section>', '随内容展开')
    await page.waitForFunction(() => document.querySelector('iframe').clientHeight > 1600)
    assert.equal(await frame.locator('#widget-root').evaluate(node => getComputedStyle(node).maxHeight), 'none')
    assert.equal(await frame.locator('#widget-root').evaluate(node => getComputedStyle(node).overflowY), 'visible')
    assert.equal(await frame.evaluate(() => document.scrollingElement.scrollHeight <= innerHeight + 1), true)
    const naturalHeight = (await page.locator('iframe').boundingBox()).height
    await page.mouse.move(200, 250); await page.mouse.wheel(0, 500)
    await page.waitForFunction(() => scrollY > 0)
    assert.equal(await frame.evaluate(() => scrollY), 0)
    await frame.locator('summary').click()
    await page.waitForFunction(initial => document.querySelector('iframe').clientHeight > initial + 800, naturalHeight)
    assert.equal(await frame.evaluate(() => document.scrollingElement.scrollHeight <= innerHeight + 1), true)
    if (artifacts) await page.screenshot({ path: path.join(artifacts, 'full-content-height.png'), fullPage: true })
    await frame.locator('summary').click()
    await page.waitForFunction(initial => Math.abs(document.querySelector('iframe').clientHeight - initial) <= 1, naturalHeight)
    await context.writeArtifactJson('full-content-height.json', { height: naturalHeight, internalVerticalScroll: false, outerPageScrolls: true, expansionAndShrinking: true })
    results.push('content-height-above1600-expands-shrinks-and-wheel-scrolls-outer-page')
    frame = await run('<script>while(true){}</script>', '禁止任意脚本', { expectError: true })
    assert.equal(await page.evaluate(() => globalThis.receipts.filter(item => item.type === 'error').at(-1).payload.message), 'invalid_widget: managed content cannot execute scripts')
    frame = await run('<p>not running</p>', '隔离门禁', { executionMode: 'isolated_html', expectError: true })
    assert.match(await page.evaluate(() => globalThis.receipts.filter(item => item.type === 'error').at(-1).payload.message), /separately verified/)
    await run('<div data-kcoder-recipe="compound-interest"><script type="application/json" data-kcoder-config>{"principal":-1}</script></div>', '非法本金', { expectError: true })
    assert.match(await page.evaluate(() => globalThis.receipts.filter(item => item.type === 'error').at(-1).payload.message), /compound-interest.principal/)
    for (const [values, reason, pointer] of [
      [{ '999': 10 }, 'unknown_country_id', '/values/999'],
      [{ BR: 10 }, 'invalid_country_id', '/values/BR'],
      [{ '36': 10, '036': 20 }, 'duplicate_country_id', '/values/036'],
      [{ '076': '10' }, 'invalid_country_value', '/values/076'],
      [[], 'invalid_map_values', '/values'],
    ]) {
      await run(`<script type="application/json" data-kcoder-map>${JSON.stringify({ values })}</script>`, '非法地区数据', { expectError: true })
      const error = await page.evaluate(() => globalThis.receipts.filter(item => item.type === 'error').at(-1).payload.message)
      assert.ok(error.includes(pointer) && error.includes(reason), error)
      assert.equal(await page.evaluate(() => globalThis.receipts.some(item => item.type === 'ready')), false)
    }
    assert.deepEqual(forbiddenRequests, [])
    results.push('no-network-and-explicit-arbitrary-js-gate')
    return { results, browser: await browser.version(), nativeIsolation: 'not tested; synchronous loops in an iframe have no hard CPU timeout' }
  } finally {
    await chromium?.close()
    await new Promise(resolve => server.close(resolve))
  }
}
