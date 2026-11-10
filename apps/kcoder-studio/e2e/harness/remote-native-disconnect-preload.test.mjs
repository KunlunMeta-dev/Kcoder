import assert from 'node:assert/strict';
import { once } from 'node:events';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { RunContext } from './run-context.mjs';

test('owned no-network SSH spawn survives the actual preload setup', async () => {
  const context = await RunContext.create(import.meta.url, { testId: 'owned-remote-disconnect-preload-setup' });
  let failure;
  try {
    const child = context.spawnOwned('owned-spawn-probe', process.execPath, ['--import',
      fileURLToPath(new URL('./remote-native-disconnect-fault.mjs', import.meta.url)),
      fileURLToPath(new URL('./remote-native-disconnect-spawn-probe.mjs', import.meta.url))], {
      env: context.isolatedEnvironment({ KCODER_E2E_NATIVE_REMOTE_DISCONNECT: '1', KCODER_E2E_NATIVE_REMOTE_DISCONNECT_DIRECTORY: context.artifactsDir }),
    });
    const [code] = await once(child, 'close', { signal: AbortSignal.timeout(5000) });
    const log = await readFile(context.processes.get('owned-spawn-probe').logPath, 'utf8');
    assert.equal(code, 0, log);
    assert.match(log, /owned-spawn-probe-complete/);
  } catch (error) { failure = error; }
  await context.finish(failure ? 'failed' : 'passed', { noNetwork: true }, failure);
  if (failure) throw failure;
});
