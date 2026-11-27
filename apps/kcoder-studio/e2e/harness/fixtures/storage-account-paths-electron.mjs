import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import { app } from 'electron';

const root = resolve(process.env.KCODER_E2E_STORAGE_ACCOUNT_ROOT);
const report = process.env.KCODER_E2E_STORAGE_ACCOUNT_REPORT;
assert.ok(isAbsolute(report));
const suffix = relative(root, report);
assert.ok(suffix && suffix !== '..' && !suffix.startsWith(`..${sep}`) && !isAbsolute(suffix));
assert.equal(app.isReady(), false);
// Isolate Electron's own writable profile before observing OS-derived paths.
// Do not override home/appData: the test must detect ineffective HOME isolation.
app.setPath('userData', join(root, 'electron'));
app.setPath('sessionData', join(root, 'electron'));
writeFileSync(report, JSON.stringify({
  platform: process.platform, beforeReady: !app.isReady(),
  nodeHome: homedir(), home: app.getPath('home'), appData: app.getPath('appData'),
  userData: app.getPath('userData'), sessionData: app.getPath('sessionData'),
}), { flag: 'wx', mode: 0o600 });
app.exit(0);
