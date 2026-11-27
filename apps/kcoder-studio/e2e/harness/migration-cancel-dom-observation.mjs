import { randomUUID } from 'node:crypto';

/** Serialized into the owned page; no product state, RPC or source text is changed. */
export function installSmallAssetCancelObserver({ key }, env = globalThis) {
  if (env[key]) throw new Error('Cancellation observer already exists');
  const scope = env.document.querySelector('[data-testid="migration-dialog"]');
  if (!scope) throw new Error('Owned migration dialog is missing');
  const state = { armedAt: env.performance.now(), timeOrigin: env.performance.timeOrigin, clickAt: null, firstRenderedAt: null,
    firstViewportAt: null, firstText: null, clickCount: 0, frames: 0, timedOut: false };
  const stages = { '正在请求取消…': 'request_pending', '正在安全停止': 'native_requested', '已取消后续迁移': 'terminal_cancelled' };
  let frame = null, stopped = false;
  const rectIntersects = (a, b) => a.right > b.left && a.left < b.right && a.bottom > b.top && a.top < b.bottom;
  const visibility = element => {
    const rect = element.getBoundingClientRect();
    if (!element.isConnected || !element.getClientRects().length || rect.width <= 0 || rect.height <= 0) return null;
    let inViewport = rectIntersects(rect, { left: 0, top: 0, right: env.innerWidth, bottom: env.innerHeight });
    for (let parent = element, depth = 0; parent && depth < 64; parent = parent.parentElement, depth++) {
      const style = env.getComputedStyle(parent);
      if (style.display === 'none' || style.visibility === 'hidden' || style.visibility === 'collapse' || Number(style.opacity) === 0) return null;
      if (/(?:auto|scroll|hidden|clip)/.test(`${style.overflowX} ${style.overflowY}`)
        && !rectIntersects(rect, parent.getBoundingClientRect())) inViewport = false;
    }
    return { inViewport, rect: { x: rect.x, y: rect.y, width: rect.width, height: rect.height } };
  };
  const stop = () => {
    stopped = true; observer.disconnect(); scope.removeEventListener('click', clicked, true);
    if (frame !== null) env.cancelAnimationFrame(frame); frame = null;
  };
  const sample = () => {
    frame = null;
    if (stopped || state.clickAt === null) return;
    state.frames++;
    for (const element of scope.querySelectorAll('[role="status"], button')) {
      const text = element.textContent.trim(); if (!Object.hasOwn(stages, text)) continue;
      const fact = visibility(element); if (!fact) continue;
      if (state.firstRenderedAt === null) {
        state.firstRenderedAt = env.performance.now(); state.firstText = text; state.firstStage = stages[text]; state.firstRect = fact.rect;
      }
      if (fact.inViewport && state.firstViewportAt === null) {
        state.firstViewportAt = env.performance.now(); state.viewportText = text; state.viewportStage = stages[text];
      }
    }
    if (state.firstViewportAt !== null) { stop(); return; }
    if (env.performance.now() - state.clickAt >= 10000) { state.timedOut = true; stop(); return; }
    frame = env.requestAnimationFrame(sample);
  };
  const schedule = () => { if (!stopped && state.clickAt !== null && frame === null) frame = env.requestAnimationFrame(sample); };
  const clicked = event => {
    const button = event.target?.closest?.('button');
    if (!event.isTrusted || !button || !scope.contains(button) || button.textContent.trim() !== '取消本次迁移') return;
    state.clickCount++; if (state.clickAt === null) state.clickAt = env.performance.now(); schedule();
  };
  const observer = new env.MutationObserver(schedule);
  observer.observe(scope, { childList: true, characterData: true, subtree: true, attributes: true });
  scope.addEventListener('click', clicked, true);
  const entry = { state, stop }; env[key] = entry;
  return { key, armed: true };
}

export async function startSmallAssetCancelDomObservation(page) {
  const key = `kcoderQ2Cancel_${randomUUID().replaceAll('-', '')}`;
  await page.evaluate(installSmallAssetCancelObserver, { key });
  return {
    async read() { return page.evaluate(key => ({ ...globalThis[key].state }), key); },
    async rendered() {
      await page.waitForFunction(key => globalThis[key]?.state.firstRenderedAt != null, key, { polling: 'raf', timeout: 10000 });
      return this.read();
    },
    async dispose() { await page.evaluate(key => { const entry = globalThis[key]; if (entry) { entry.stop(); delete globalThis[key]; } }, key).catch(() => {}); },
  };
}
