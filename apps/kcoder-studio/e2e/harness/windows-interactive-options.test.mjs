import assert from 'node:assert/strict';
import test from 'node:test';
import { resolveWindowsInteractiveOptions } from './windows-interactive-options.mjs';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, lstat, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const env = (...names) => Object.fromEntries(names.map(name => [`KCODER_E2E_WINDOWS_${name}`, '1']));

test('interactive modes report the options actually sent to the owned Windows probe', () => {
  assert.deepEqual(resolveWindowsInteractiveOptions({}), { taskHost: false, testId: 'windows-owned-model-settings-session', args: ['--model-scope', '--installed-resources'] });
  assert.deepEqual(resolveWindowsInteractiveOptions(env('NATIVE_INPUT')).args, ['--model-scope', '--native-input', '--installed-resources']);
  for (const [name, id, flag] of [
    ['STREAMING', 'windows-owned-task-streaming-latency', '--task-streaming'],
    ['TOOL_SELECTIONS', 'windows-owned-kcoder-spec-tool-selection', '--tool-selections'],
    ['KWORKER', 'windows-owned-task-kworker', '--kworker'],
  ]) {
    const result = resolveWindowsInteractiveOptions(env('TASK_HOST', name));
    assert.equal(result.testId, id);
    assert.deepEqual(result.args, ['--task-host', flag, '--installed-resources']);
    assert.throws(() => resolveWindowsInteractiveOptions(env(name)), /require KCODER_E2E_WINDOWS_TASK_HOST=1/);
  }
  const combined = resolveWindowsInteractiveOptions(env('TASK_HOST', 'STREAMING', 'TOOL_SELECTIONS', 'KWORKER', 'TASK_HOST_STDIO'));
  assert.equal(combined.testId, 'windows-owned-task-streaming-tool-selection-kworker');
  assert.deepEqual(combined.args, ['--task-host', '--task-streaming', '--tool-selections', '--kworker', '--stdio-only']);
  assert.deepEqual(resolveWindowsInteractiveOptions(env('TASK_HOST', 'TASK_HOST_CANDIDATE')).args, ['--task-host']);
});

test('ignored task-host and conflicting input settings are rejected before resource creation', () => {
  for (const name of ['TASK_HOST_STDIO', 'TASK_HOST_CANDIDATE']) assert.throws(() => resolveWindowsInteractiveOptions(env(name)), /require KCODER_E2E_WINDOWS_TASK_HOST=1/);
  assert.throws(() => resolveWindowsInteractiveOptions(env('TASK_HOST', 'NATIVE_INPUT')), /mutually exclusive/);
});

test('native dialog qualification rejects missing interactive/session pins before staging or SSH', async t => {
  const execute = promisify(execFile);
  try { await execute('python3', ['--version']); }
  catch (error) { if (error.code === 'ENOENT') { t.skip('python3 is required for the existing Windows transport'); return; } throw error; }
  const root = await mkdtemp(join(tmpdir(), 'native-dialog-entry-'));
  t.after(() => rm(root, { recursive: true }));
  const evidence = join(root, 'not-created');
  const args = [fileURLToPath(new URL('windows-widget-owned-run.py', import.meta.url)),
    '--root-source', root, '--preparation', 'not-read.json', '--runtime', 'not-read.zip',
    '--supervisor', 'not-read.exe', '--target', 'must-not-connect.invalid', '--node', 'not-run.exe',
    '--evidence', evidence, '--suite', 'storage-dialog-cancel'];
  for (const flags of [[], ['--interactive'], ['--interactive', '--session-id', '0']]) {
    await assert.rejects(execute('python3', [...args, ...flags]), error => {
      assert.match(error.stderr, /Exact existing interactive session required/);
      return true;
    });
    await assert.rejects(lstat(evidence), { code: 'ENOENT' });
  }
});
