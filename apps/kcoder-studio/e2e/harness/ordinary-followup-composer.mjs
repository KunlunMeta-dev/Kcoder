import assert from 'node:assert/strict';
import { waitFor } from './run-context.mjs';

/** Observe actual DOM commits and painted geometry during an ordinary User
 * followup. Removed transient nodes are inspected from MutationRecords too.
 */
export async function assertOrdinaryFollowupComposer(context, page, wire, { threadId, prompt, response, expectedConfiguredModel }) {
  await waitFor(() => wire.some(row => row.lane === 'browser-turn-state' && row.method === 'turn/completed'
    && row.threadId === threadId && row.status === 'completed'), 30_000, 'original seed native terminal receipt');
  await page.evaluate(() => document.fonts.ready);
  await page.getByTestId('chat-message-input').fill(prompt);
  const readReadiness = () => page.evaluate(() => {
    const send = document.querySelector('[data-testid="send-message-button"]');
    const controls = document.querySelector('[data-testid="composer-toolbar-model-controls"]');
    const model = document.querySelector('[data-testid="model-selector-button"]');
    return { observedAtMs: Date.now(), sendEnabled: send instanceof HTMLButtonElement && !send.disabled,
      modelControlsBusy: controls?.getAttribute('aria-busy'), modelLabel: model?.textContent?.trim() ?? null,
      modelButtonDisabled: model instanceof HTMLButtonElement ? model.disabled : null };
  });
  const readiness = { before: await readReadiness() };
  try {
    await waitFor(async () => {
      const state = await readReadiness();
      const catalog = wire.findLast(row => row.method === 'runtime.models.list' && row.threadId === threadId && row.replyObserved && !row.errorCode);
      const configured = !expectedConfiguredModel || catalog?.modelCatalog?.some(model =>
        model.model === expectedConfiguredModel.model && model.providerId === expectedConfiguredModel.providerId && model.isDefault && model.available);
      return state.sendEnabled && state.modelControlsBusy === 'false' && configured;
    }, 30_000, 'actual original-thread model catalog and composer readiness');
  } finally {
    readiness.after = await readReadiness();
    readiness.catalog = wire.filter(row => row.method === 'runtime.models.list');
    await context.writeArtifactJson('ordinary-followup-model-readiness.json', readiness);
  }
  const began = wire.length;
  await page.evaluate(() => {
    const layer = document.querySelector('[data-testid="desktop-floating-composer-layer"]');
    if (!(layer instanceof HTMLElement)) throw new Error('Actual composer layer is missing');
    const queueSelector = '[data-testid="conversation-queue-panel"], [data-testid^="conversation-queue-row-"], [data-status-item="queue"]';
    const rect = () => {
      const box = layer.getBoundingClientRect();
      const scrollAncestors = [];
      for (let node = layer.parentElement; node; node = node.parentElement) {
        if (node.scrollHeight > node.clientHeight || node.scrollTop) scrollAncestors.push({
          testId: node.getAttribute('data-testid'), tag: node.tagName, scrollTop: node.scrollTop,
          height: node.clientHeight, scrollHeight: node.scrollHeight });
      }
      return { y: box.y, height: box.height, windowScrollY: window.scrollY, scrollAncestors };
    };
    const ancestors = () => {
      const result = [];
      for (let node = layer; node instanceof HTMLElement; node = node.parentElement) {
        const box = node.getBoundingClientRect(), style = getComputedStyle(node);
        result.push({ tag: node.tagName, testId: node.getAttribute('data-testid'),
          y: box.y, height: box.height, scrollTop: node.scrollTop, scrollHeight: node.scrollHeight,
          clientHeight: node.clientHeight, overflowY: style.overflowY, transform: style.transform });
      }
      return result;
    };
    const baseline = rect(), samples = [], insertedQueueNodes = [], statusInsertions = [], geometryChanges = [];
    let geometryKey;
    const sampleGeometry = kind => {
      const value = rect();
      if (samples.length < 2048) samples.push({ at: performance.now(), kind, ...value });
      const key = `${value.y}:${value.height}`;
      if (key !== geometryKey) {
        geometryKey = key;
        if (geometryChanges.length < 64) geometryChanges.push({ at: performance.now(), kind, ...value,
          windowScrollY: window.scrollY, viewportHeight: window.innerHeight,
          focusedTestId: document.activeElement?.getAttribute('data-testid'), ancestors: ancestors() });
      }
    };
    const originalStatuses = new Set([...layer.querySelectorAll('[data-status-item]')].map(node => node.getAttribute('data-status-item')));
    const seen = new WeakSet(), queueSeen = new WeakSet();
    const inspect = root => {
      if (!(root instanceof Element)) return;
      for (const node of [root, ...root.querySelectorAll(queueSelector + ',[data-status-item]')]) {
        if (node.matches(queueSelector) && !queueSeen.has(node)) {
          queueSeen.add(node); if (insertedQueueNodes.length < 64) insertedQueueNodes.push({
            at: performance.now(), testId: node.getAttribute('data-testid'), status: node.getAttribute('data-status-item') });
        }
        const status = node.getAttribute('data-status-item');
        if (status && !originalStatuses.has(status) && !seen.has(node)) {
          seen.add(node); if (statusInsertions.length < 64) statusInsertions.push({ at: performance.now(), status });
        }
      }
    };
    for (const node of layer.querySelectorAll(queueSelector)) inspect(node);
    const observer = new MutationObserver(records => {
      for (const record of records) {
        if (record.type === 'attributes') inspect(record.target);
        for (const node of record.addedNodes) inspect(node);
      }
      sampleGeometry('mutation');
    });
    observer.observe(layer, { childList: true, subtree: true, attributes: true, attributeFilter: ['data-testid', 'data-status-item'] });
    let active = true;
    const sample = () => { if (!active) return; sampleGeometry('frame'); requestAnimationFrame(sample); };
    requestAnimationFrame(sample);
    window.__peerOrdinaryFollowupComposer = { stop() {
      active = false; observer.disconnect();
      const final = rect(); sampleGeometry('final');
      return { baseline, final, samples, geometryChanges, insertedQueueNodes, statusInsertions,
        maximumYShiftPx: Math.max(0, ...samples.map(row => Math.abs(row.y - baseline.y))),
        maximumHeightShiftPx: Math.max(0, ...samples.map(row => Math.abs(row.height - baseline.height))) };
    } };
  });
  let result;
  try {
    await page.screenshot({ path: context.pathInArtifacts('ordinary-followup-composer-before.png'), fullPage: false });
    const send = page.getByTestId('send-message-button');
    assert.equal(await send.isEnabled(), true);
    const button = await send.boundingBox(); assert.ok(button);
    const point = { x: button.x + button.width / 2, y: button.y + button.height / 2 };
    assert.equal(await send.evaluate((element, point) => element.contains(document.elementFromPoint(point.x, point.y)), point), true,
      'The actual send control is hit-testable without automatic scrolling');
    await page.mouse.click(point.x, point.y);
    const accepted = await waitFor(() => wire.slice(began).find(row => row.method === 'turn/start' && row.threadId === threadId && row.acceptedTurnId),
      30_000, 'ordinary original-thread accepted receipt');
    await waitFor(() => wire.slice(began).find(row => row.lane === 'browser-turn-state' && row.method === 'turn/started'
      && row.threadId === threadId && row.turnId === accepted.acceptedTurnId), 30_000, 'ordinary original-thread running state');
    await page.screenshot({ path: context.pathInArtifacts('ordinary-followup-composer-running.png'), fullPage: false });
    await page.getByTestId('message-assistant').filter({ hasText: response }).waitFor({ timeout: 30_000 });
    await waitFor(() => wire.slice(began).find(row => row.lane === 'browser-turn-state' && row.method === 'turn/completed'
      && row.threadId === threadId && row.turnId === accepted.acceptedTurnId && row.status === 'completed'), 30_000, 'ordinary followup native terminal receipt');
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  } finally {
    result = await page.evaluate(() => window.__peerOrdinaryFollowupComposer.stop());
    await context.writeArtifactJson('ordinary-followup-composer-observation.json', result);
    await page.screenshot({ path: context.pathInArtifacts('ordinary-followup-composer-after.png'), fullPage: true });
  }
  assert.equal(result.insertedQueueNodes.length, 0, 'An ordinary original-thread send never inserts a queue/submission block');
  assert.equal(result.statusInsertions.length, 0, 'An ordinary original-thread send never inserts a temporary composer status');
  assert.ok(result.maximumYShiftPx <= 2, `Ordinary followup composer y moved ${result.maximumYShiftPx}px`);
  assert.ok(result.maximumHeightShiftPx <= 2, `Ordinary followup composer height moved ${result.maximumHeightShiftPx}px`);
  return result;
}
