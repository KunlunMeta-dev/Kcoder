import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runE2E } from '../harness/run-context.mjs';
import { startChromium } from '../harness/chromium.mjs';

if (process.env.KCODER_E2E_LIVE_GATEWAY_CONNECTIVITY !== '1') throw new Error('Explicit live connectivity acceptance consent is required');
const loginFile = process.env.KCODER_E2E_CONNECTIVITY_LOGIN_FILE;
if (!loginFile) throw new Error('A private current Gateway login URL file is required');
const appRoot = fileURLToPath(new URL('../../', import.meta.url));
process.umask(0o077);
await runE2E(import.meta.url, {
  testId: 'current-mobile-connectivity-readonly', tier: 'manual-live',
  modelPolicy: 'Explicit live acceptance; current Gateway, run-owned device authorizations with exact revocation and inventory reads only; no conversations or models',
}, async run => {
  const login = new URL((await readFile(loginFile, 'utf8')).trim());
  const pairingToken = new URLSearchParams(login.hash.slice(1)).get('token');
  const browserToken = login.searchParams.get('token');
  assert.ok(pairingToken);
  run.registerSecret(pairingToken); if (browserToken) run.registerSecret(browserToken);
  const baseUrl = login.searchParams.get('gateway') || login.origin + login.pathname.replace(/\/login$/, '');
  login.hash = '';
  const esbuild = createRequire(resolve(appRoot, 'mobile/package.json'))('esbuild');
  const bundle = await esbuild.build({
    entryPoints: [resolve(appRoot, 'e2e/private/mobile-current-connectivity.browser.ts')], bundle: true,
    write: false, platform: 'browser', format: 'iife', globalName: 'CurrentMobileConnectivity',
    target: 'es2022', mainFields: ['browser', 'module', 'main'],
    resolveExtensions: ['.web.ts', '.web.tsx', '.web.js', '.ts', '.tsx', '.js', '.mjs', '.json'],
    plugins: [{ name: 'production-web-platform-and-webcrypto', setup(build) {
      build.onResolve({ filter: /^react-native$/ }, () => ({ path: 'web-platform', namespace: 'owned-web-platform' }));
      build.onLoad({ filter: /.*/, namespace: 'owned-web-platform' }, () => ({
        contents: `export { default as Platform } from "react-native-web/dist/exports/Platform";`,
        resolveDir: resolve(appRoot, 'mobile'), loader: 'js',
      }));
      build.onResolve({ filter: /^\.\/connection-route-crypto$/ }, () => ({
        path: resolve(appRoot, 'e2e/private/mobile-peer-transport-crypto-adapter.browser.ts'),
      }));
    } }],
  });
  const browser = await startChromium(run, { label: 'current-connectivity', noSandbox: true });
  const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
  // Load a small same-origin capability document; this acceptance does not load the UI bundle.
  console.log('Opening current public Gateway capability');
  await page.goto(`${baseUrl}/api/mobile/p2p`, { waitUntil: 'domcontentloaded', timeout: 30000 });
  await page.evaluate(bundle.outputFiles[0].text);
  console.log('Inspecting production automatic route selection');
  const inspect = label => page.evaluate(config => window.CurrentMobileConnectivity.inspectCurrentConnectivity(config), {
    baseUrl, token: pairingToken, label: `${run.runRoot.split('/').at(-1)}-${label}`,
  });
  const direct = await inspect('direct');
  console.log(`Selected automatic route: ${direct.kind}`);
  assert.equal(direct.kind, 'peer', 'The automatic direct transport must be P2P');
  await page.route('**/api/mobile/p2p', route => route.abort('failed'));
  const fallback = await inspect('fallback');
  console.log(`Selected unavailable-direct fallback: ${fallback.kind}`);
  assert.equal(fallback.kind, 'public', 'Unavailable direct transports must retain the configured public path');
  return { direct, fallback, ownedDevicesRevoked: true,
    boundary: 'Current production transport source in an owned Chromium; live Gateway inventory only; no native phone or model proof' };
});
