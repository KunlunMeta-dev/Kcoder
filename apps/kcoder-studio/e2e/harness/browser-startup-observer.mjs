import { expect } from '../../renderer/node_modules/@playwright/test/index.mjs';

export const roundedMilliseconds = value => Math.round(value * 10) / 10;

/** Observe actual frontend initialize round trips without retaining URL/authentication data. */
export function observeFrontendInitialize(page, phase = () => 'startup') {
  const samples = [];
  page.on('websocket', socket => {
    const pending = new Map();
    socket.on('framesent', ({ payload }) => {
      let frame; try { frame = JSON.parse(String(payload)); } catch { return; }
      if (frame.method === 'initialize' && frame.id !== undefined) pending.set(frame.id, { at: performance.now(), phase: phase() });
    });
    socket.on('framereceived', ({ payload }) => {
      let frame; try { frame = JSON.parse(String(payload)); } catch { return; }
      const start = pending.get(frame.id);
      if (start && (frame.result !== undefined || frame.error !== undefined)) {
        samples.push({ phase: start.phase, durationMs: roundedMilliseconds(performance.now() - start.at), succeeded: frame.error === undefined }); pending.delete(frame.id);
      }
    });
  });
  return samples;
}

export async function signInAndWaitSidebar(page, gateway) {
  await page.goto(gateway.baseUrl, { waitUntil: 'domcontentloaded' });
  const input = page.locator('input[name="token"]');
  if (await input.count()) { await input.fill(gateway.authToken); await page.locator('button[type="submit"]').click(); }
  await expect(page.getByTestId('desktop-sidebar')).toBeVisible({ timeout: 30000 });
  return performance.now();
}
