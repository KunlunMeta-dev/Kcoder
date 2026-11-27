import test from 'node:test';
import assert from 'node:assert/strict';
import { localMcpPresetsForTarget } from './local-mcp-presets.mjs';

const local = { id: 'local', transport: 'local' };
const posixRuntime = { binDirectory: '/home/u/.studio/skill-runtime/bin', launchers: ['node', 'playwright-mcp'] };

test('local same-account targets receive the Playwright launcher and a private output directory', () => {
  assert.deepEqual(localMcpPresetsForTarget(posixRuntime, local, 'linux'), {
    version: 1,
    playwright: {
      command: 'playwright-mcp',
      defaultBrowser: 'chrome',
      outputDirectory: '/home/u/.studio/skill-runtime/playwright-mcp-output',
    },
  });
  assert.equal(localMcpPresetsForTarget(posixRuntime, local, 'darwin').playwright.defaultBrowser, 'chrome');
});

test('Windows uses the batch launcher, Edge by default and a drive path', () => {
  const runtime = {
    binDirectory: 'C:\\Users\\u\\AppData\\Roaming\\KCoder Studio\\skill-runtime\\bin',
    launchers: ['node', 'node.cmd', 'playwright-mcp', 'playwright-mcp.cmd'],
  };
  assert.deepEqual(localMcpPresetsForTarget(runtime, local, 'win32').playwright, {
    command: 'playwright-mcp.cmd',
    defaultBrowser: 'msedge',
    outputDirectory: 'C:\\Users\\u\\AppData\\Roaming\\KCoder Studio\\skill-runtime\\playwright-mcp-output',
  });
  // The extensionless POSIX script alone cannot be started by Windows.
  assert.equal(localMcpPresetsForTarget({ ...runtime, launchers: ['playwright-mcp'] }, local, 'win32'), undefined);
});

test('remote, account-isolated and runtime-less targets receive no preset facts', () => {
  for (const target of [
    { id: 'ssh', transport: 'ssh' },
    { id: 'isolated', transport: 'local', security: { identity: { mode: 'kcoder-account' } } },
    undefined,
  ]) assert.equal(localMcpPresetsForTarget(posixRuntime, target, 'linux'), undefined);
  for (const runtime of [
    null,
    { binDirectory: null, launchers: [] },
    { binDirectory: '/bin-dir', launchers: ['node'] },
    { binDirectory: 'relative/bin', launchers: ['playwright-mcp'] },
  ]) assert.equal(localMcpPresetsForTarget(runtime, local, 'linux'), undefined);
});
