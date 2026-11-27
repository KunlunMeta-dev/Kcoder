import test from 'node:test';
import assert from 'node:assert/strict';
import { boundedJson, platformJson } from '../src/transport.mjs';
import { platformMultipart } from '../src/upload-transport.mjs';

test('a declared oversized JSON body is cancelled without reading it', async () => {
  let cancelled = 0;
  const response = new Response(new ReadableStream({ cancel() { cancelled++; } }), { headers: { 'content-length': '1000' } });
  await assert.rejects(boundedJson(response, 10), { code: 'PLATFORM_RESPONSE_TOO_LARGE' });
  assert.equal(cancelled, 1);
});

for (const [status, code, externalOutcome] of [[401, 'PLATFORM_AUTHORIZATION_FAILED', 'failed'],
  [403, 'PLATFORM_AUTHORIZATION_FAILED', 'failed'], [429, 'PLATFORM_RATE_LIMIT', 'failed'], [502, 'PLATFORM_HTTP_REJECTED', 'unknown']]) {
  test(`HTTP ${status} retains its classification when the platform returns a non-JSON body`, async () => {
    const fetchImpl = async () => new Response('<html>private upstream failure</html>', { status });
    await assert.rejects(platformJson('https://open.feishu.cn/fixture', { hosts: ['open.feishu.cn'], fetchImpl }), { code, externalOutcome });
  });
}

test('multipart authorization errors are mapped before decoding', async () => {
  await assert.rejects(platformMultipart('https://open.feishu.cn/fixture', {
    hosts: ['open.feishu.cn'], file: { filename: 'fixture.txt', mediaType: 'text/plain', expectedBytes: 1,
      byteStream: async function* () { yield Buffer.from('x'); } },
    fetchImpl: async () => new Response('denied', { status: 403 }),
  }), { code: 'PLATFORM_AUTHORIZATION_FAILED', externalOutcome: 'failed' });
});
