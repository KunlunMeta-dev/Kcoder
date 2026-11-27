import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { repoRoot } from './run-context.mjs';

test('owned CDP launcher can coexist with the terminal harness separate Playwright test installation', () => {
  const terminal = pathToFileURL(resolve(repoRoot, 'tools/tui-lab/node_modules/@playwright/test/index.mjs')).href;
  const launcher = new URL('./chromium.mjs', import.meta.url).href;
  const child = spawnSync(process.execPath, ['--input-type=module', '-e',
    `await import(${JSON.stringify(terminal)}); const {startChromium}=await import(${JSON.stringify(launcher)}); if(typeof startChromium!=='function') process.exit(2);`],
  { cwd: repoRoot, timeout: 10_000, encoding: 'utf8', env: { PATH: process.env.PATH } });
  assert.equal(child.status, 0, child.stderr);
  assert.equal(child.signal, null);
});
