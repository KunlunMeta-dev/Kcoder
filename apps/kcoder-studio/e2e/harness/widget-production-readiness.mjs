import assert from 'node:assert/strict';

const declaration = config => `<script type="application/json" data-kcoder-chart>${JSON.stringify(config)}</script>`;
const config = data => ({ type: 'bar', data: { labels: ['A', 'B'], datasets: [{ label: 'Values', data }] } });
export const productionReadinessSamples = [
  { format: 'html', libraries: ['chart_js'], widget_code: '<style>.widget-chart-canvas{width:0!important;height:0!important}</style>' + declaration(config([2, 5])) },
  { format: 'html', libraries: ['chart_js'], widget_code: declaration({ ...config([2, 5]), options: { plugins: false } }) },
  { format: 'html', libraries: ['chart_js'], widget_code: declaration(config([null, null])) },
];

export async function verifyProductionDrawingReadiness(context, page, model) {
  const results = [];
  const readOutputs = (model.requests.at(-1)?.messages ?? []).filter(message => message.role === 'tool').map(message => {
    const text = typeof message.content === 'string' ? message.content : message.content.map(block => block.text || '').join('');
    return JSON.parse(text.split('\n')[0]);
  }).filter(value => value.status === 'recorded');
  assert.equal(readOutputs.length, productionReadinessSamples.length);
  for (let index = 0; index < productionReadinessSamples.length; index++) {
    const host = page.getByTestId('inline-widget').filter({ has: page.getByText(`Completed panel ${index + 1}`, { exact: true }) }).first();
    await host.scrollIntoViewIfNeeded();
    await page.waitForTimeout(2300);
    const frame = await (await host.locator('iframe').elementHandle())?.contentFrame();
    assert.ok(frame, 'The real managed document must remain available');
    const canvas = await frame.evaluate(() => {
      const node = document.querySelector('canvas'); const rect = node.getBoundingClientRect();
      const chart = globalThis.Chart.getChart(node); const pixels = node.width && node.height ? node.getContext('2d').getImageData(0, 0, node.width, node.height).data : [];
      let paintedPixels = 0; for (let alpha = 3; alpha < pixels.length; alpha += 4) if (pixels[alpha]) paintedPixels++;
      return { physical: [node.width, node.height], layout: [rect.width, rect.height], bound: Boolean(chart), data: chart?.data.datasets[0].data,
        emptyState: document.querySelector('[data-widget-empty-chart]')?.textContent, paintedPixels };
    });
    results.push({ index, status: await host.getAttribute('data-widget-status'), canvas, read: readOutputs[index] });
    await context.writeArtifactJson(`production-drawing-readiness-${index}.json`, results.at(-1));
    if (index === 0) {
      assert.equal(results.at(-1).status, 'unconfirmed');
      assert.ok(canvas.physical.includes(0) || canvas.layout.includes(0));
      assert.equal(readOutputs[index].render_observation, undefined, 'Zero-sized source must not acquire a rendered or failed receipt');
    } else {
      assert.equal(results.at(-1).status, 'ready');
      assert.equal(readOutputs[index].render_observation?.status, 'rendered');
      assert.ok(canvas.physical.every(value => value > 0) && canvas.layout.every(value => value > 0));
      assert.equal(canvas.bound, true);
      if (index === 1) { assert.deepEqual(canvas.data, [2, 5]); assert.ok(canvas.paintedPixels > 1000); }
      else { assert.deepEqual(canvas.data, [null, null]); assert.ok(canvas.emptyState); }
    }
  }
  return { actualCharts: results.length, zeroUnconfirmed: true, pixelsAndReadAgree: true, missingDataPreserved: true };
}
