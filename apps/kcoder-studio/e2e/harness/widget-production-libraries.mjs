import assert from 'node:assert/strict';

const chart = config => `<script type="application/json" data-kcoder-chart>${JSON.stringify(config)}</script>`;
export const productionLibrarySamples = [
  { format: 'svg', widget_code: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 600 180"><text x="20" y="60">STATIC_LIBRARY_CONTROL</text></svg>' },
  { format: 'html', libraries: ['chart_js'], widget_code: chart({ type: 'bar', data: { labels: ['A', 'B'], datasets: [{ label: 'Count', data: [10, 12] }] } }) },
  { format: 'html', libraries: ['chart_js'], widget_code: chart({ data: { labels: ['A', 'B'], datasets: [{ type: 'bar', label: 'Actual', data: [10, 12] }, { type: 'line', label: 'Target', data: [11, 14] }] } }) },
  { format: 'html', libraries: ['d3', 'topojson'], widget_code: '<script type="application/json" data-kcoder-map>{"values":{"156":10,"840":20},"markers":[{"label":"Shanghai","longitude":121.4737,"latitude":31.2304}]}</script>' },
];

/** Observe real init payloads and policy failures without injecting library code. */
export async function observeProductionLibraries(page) {
  const consoleErrors = [];
  page.on('console', message => {
    if (message.type() === 'error' && consoleErrors.length < 40) consoleErrors.push(message.text().slice(0, 1800));
  });
  await page.addInitScript(() => {
    window.__widgetLibraryObservation = { init: null, csp: [] };
    addEventListener('securitypolicyviolation', event => {
      const observation = window.__widgetLibraryObservation;
      if (observation.csp.length < 20) observation.csp.push({ directive: event.effectiveDirective, blocked: event.blockedURI, sample: event.sample.slice(0, 128) });
    });
    addEventListener('message', async event => {
      const data = event.data;
      if (data?.protocol !== 'kcoder-widget-host' || data.type !== 'init') return;
      const libraries = await Promise.all(Object.entries(data.librarySources || {}).map(async ([id, source]) => {
        const bytes = new TextEncoder().encode(source);
        const hash = await crypto.subtle.digest('SHA-256', bytes);
        return [id, { bytes: bytes.length, sha256: [...new Uint8Array(hash)].map(byte => byte.toString(16).padStart(2, '0')).join('') }];
      }));
      window.__widgetLibraryObservation.init = { widgetId: data.widgetId, sourceBytes: new TextEncoder().encode(data.source).length, libraries: Object.fromEntries(libraries) };
    });
  });
  return consoleErrors;
}

export async function verifyProductionLibraries(context, page, consoleErrors) {
  const results = [];
  try {
    for (let index = 0; index < productionLibrarySamples.length; index++) {
      const host = page.getByTestId('inline-widget').filter({ has: page.getByText(`Completed panel ${index + 1}`, { exact: true }) }).first();
      await host.scrollIntoViewIfNeeded();
      await page.waitForTimeout(800);
      const iframe = await host.locator('iframe').elementHandle();
      const frame = iframe && await iframe.contentFrame();
      const observation = frame ? await frame.evaluate(() => ({
        ...window.__widgetLibraryObservation,
        chartVersion: globalThis.Chart?.version,
        d3Type: typeof globalThis.d3,
        topojsonType: typeof globalThis.topojson,
        text: document.getElementById('widget-root')?.textContent,
        canvases: [...document.querySelectorAll('canvas')].map(canvas => {
          const pixels = canvas.getContext('2d').getImageData(0, 0, canvas.width, canvas.height).data;
          let paintedPixels = 0;
          for (let alpha = 3; alpha < pixels.length; alpha += 4) if (pixels[alpha] > 0) paintedPixels++;
          return { width: canvas.width, height: canvas.height, paintedPixels, labels: globalThis.Chart?.getChart(canvas)?.data.labels,
            datasets: globalThis.Chart?.getChart(canvas)?.data.datasets.map(dataset => ({ type: dataset.type, label: dataset.label, data: dataset.data })) };
        }),
        tableRows: [...document.querySelectorAll('table tbody tr')].map(row => [...row.cells].map(cell => cell.textContent)),
        mapPaths: document.querySelectorAll('[data-kcoder-map-view] path').length,
        markers: [...document.querySelectorAll('[data-map-marker]')].map(node => node.dataset.mapMarker),
      })) : { missingFrame: true };
      results.push({ index, status: await host.getAttribute('data-widget-status'), observation });
      await context.writeArtifactJson(`production-library-${index}.json`, { results, consoleErrors });
      assert.equal(await host.getAttribute('data-widget-status'), 'ready', `Production library widget ${index} did not render`);
      assert.equal(observation.csp.length, 0, `Production library widget ${index} hit CSP`);
      if (index === 0) assert.match(observation.text, /STATIC_LIBRARY_CONTROL/);
      if (index === 1 || index === 2) {
        assert.equal(observation.chartVersion, '4.5.1');
        assert.equal(observation.canvases.length, 1);
        assert.ok(observation.canvases[0].width > 0 && observation.canvases[0].height > 0);
        assert.ok(observation.canvases[0].paintedPixels > 1000, 'The real canvas must contain painted pixels');
        assert.deepEqual(observation.canvases[0].labels, ['A', 'B']);
        assert.deepEqual(observation.canvases[0].datasets.map(dataset => dataset.data), index === 1 ? [[10, 12]] : [[10, 12], [11, 14]]);
        assert.deepEqual(observation.tableRows, index === 1 ? [['A', '10'], ['B', '12']] : [['A', '10', '11'], ['B', '12', '14']]);
      }
      if (index === 3) {
        assert.equal(observation.d3Type, 'object'); assert.equal(observation.topojsonType, 'object');
        assert.ok(observation.mapPaths > 150); assert.deepEqual(observation.markers, ['Shanghai']);
      }
    }
  } finally { await context.writeArtifactJson('production-library-observations.json', { results, consoleErrors }); }
  return { widgets: results.length, charts: 2, realTopologyMap: true };
}
