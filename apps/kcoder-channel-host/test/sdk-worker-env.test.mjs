import assert from 'node:assert/strict';
import test from 'node:test';
import { sdkWorkerEnvironment } from '../src/sdk-worker-env.mjs';

test('Windows worker environment preserves OS casing while excluding credentials and startup options', () => {
  const source = { Path: 'fixture-bin', windir: 'fixture-windows', SystemRoot: 'fixture-root',
    Temp: 'fixture-temp', http_proxy: 'fixture-proxy', NODE_OPTIONS: '--require=untrusted', PROVIDER_API_KEY: 'fixture-secret' };
  assert.deepEqual(sdkWorkerEnvironment(source, 'win32'), {
    Path: 'fixture-bin', windir: 'fixture-windows', SystemRoot: 'fixture-root', Temp: 'fixture-temp', http_proxy: 'fixture-proxy',
  });
});

test('Unix environment matching remains case-sensitive', () => {
  assert.deepEqual(sdkWorkerEnvironment({ PATH: 'allowed', Path: 'excluded', NODE_OPTIONS: 'excluded' }, 'linux'), { PATH: 'allowed' });
});
