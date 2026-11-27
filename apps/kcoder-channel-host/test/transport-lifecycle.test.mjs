import test from 'node:test';
import assert from 'node:assert/strict';
import { platformJson, platformBinary } from '../src/transport.mjs';
import { platformMultipart, platformBinaryUpload } from '../src/upload-transport.mjs';

const url = 'https://open.feishu.cn/fixture', hosts = ['open.feishu.cn'];
const file = { filename: 'fixture.txt', mediaType: 'text/plain', expectedBytes: 1,
  byteStream: async function* () { yield Buffer.from('x'); } };

test('all outbound helpers refuse a missing host allowlist before invoking fetch', async () => {
  let calls = 0;
  const fetchImpl = async () => { calls++; return new Response('{}'); };
  for (const request of [() => platformJson(url, { fetchImpl }), () => platformBinary(url, { fetchImpl }),
    () => platformMultipart(url, { file, fetchImpl }),
    () => platformBinaryUpload(url, { byteStream: file.byteStream(), expectedBytes: 1, fetchImpl })]) {
    await assert.rejects(request(), /UNAPPROVED_HOST/);
  }
  assert.equal(calls, 0);
});

test('binary rejection and invalid declared sizes cancel the owned response body', async () => {
  for (const [status, declared, code] of [[403, null, 'MEDIA_DOWNLOAD_REJECTED'], [200, '1000', 'INPUT_TOO_LARGE']]) {
    let cancelled = 0;
    const fetchImpl = async () => new Response(new ReadableStream({ cancel() { cancelled++; } }),
      { status, headers: declared === null ? {} : { 'content-length': declared } });
    await assert.rejects(platformBinary(url, { hosts, maxBytes: 10, fetchImpl }), error => error.code === code && error.httpStatus === status);
    assert.equal(cancelled, 1);
  }
});

test('binary responses enforce the byte budget without a content-length and cancel on overflow', async () => {
  let cancelled = 0, produced = 0;
  const response = new Response(new ReadableStream({
    pull(controller) { if (produced++ === 3) controller.close(); else controller.enqueue(Buffer.from('1234')); },
    cancel() { cancelled++; },
  }));
  const result = await platformBinary(url, { hosts, maxBytes: 5, fetchImpl: async () => response });
  await assert.rejects(async () => { for await (const chunk of result.byteStream) assert.ok(chunk.length <= 5); }, /INPUT_TOO_LARGE/);
  assert.equal(cancelled, 1);
  assert.ok(produced <= 4, 'overflow must stop producing bytes promptly');
  await result.dispose();
});

test('disposing a binary stream cancels its held source even while a consumer owns the stream lock', async () => {
  let cancelled = 0;
  const result = await platformBinary(url, { hosts, fetchImpl: async () => new Response(new ReadableStream({ cancel() { cancelled++; } })) });
  const reader = result.byteStream.getReader();
  const pending = reader.read();
  let timer;
  try {
    await result.dispose();
    const end = await Promise.race([pending, new Promise((_resolve, reject) => {
      timer = setTimeout(() => reject(new Error('owned disposal did not settle the pending read')), 50);
    })]);
    assert.equal(end.done, true);
    assert.equal(cancelled, 1);
  } finally { clearTimeout(timer); await reader.cancel().catch(() => {}); reader.releaseLock(); }
});

test('multipart success waits for the owned request body to finish after early response headers', async () => {
  let drained = false;
  const result = await platformMultipart(url, { hosts, file, fetchImpl: async (_address, options) => {
    setImmediate(() => { (async () => { for await (const chunk of options.body) void chunk; drained = true; })().catch(() => {}); });
    return new Response('{"code":0}');
  } });
  assert.equal(result.code, 0);
  assert.equal(drained, true);
});

test('a cancelled upload with an unreceived result stays unknown and is never retried', async () => {
  let calls = 0;
  const reason = Object.assign(new DOMException('fixture cancellation', 'AbortError'), { privateFixture: 'inert-private-error-detail' });
  await assert.rejects(platformMultipart(url, { hosts, file, fetchImpl: async () => {
    calls++; throw reason;
  } }), error => error.code === 'PLATFORM_UPLOAD_UNCONFIRMED' && error.externalOutcome === 'unknown'
    && error.cause === reason && !JSON.stringify(error).includes('inert-private-error-detail'));
  assert.equal(calls, 1);
});

test('an early success cannot complete an unconsumed upload after its owner aborts', async () => {
  const owner = new AbortController();
  let calls = 0;
  const timer = setTimeout(() => owner.abort(), 20);
  try {
    await assert.rejects(platformMultipart(url, { hosts, file, signal: owner.signal,
      fetchImpl: async () => { calls++; return new Response('{"code":0}', { headers: { 'content-type': 'application/json' } }); },
    }), error => error.code === 'PLATFORM_UPLOAD_UNCONFIRMED' && error.externalOutcome === 'unknown');
    assert.equal(calls, 1);
  } finally { clearTimeout(timer); }
});

test('binary upload waits for complete iterable consumption and disposes its unused response body', async () => {
  let cancelled = 0;
  const result = await platformBinaryUpload(url, { hosts, expectedBytes: 1, byteStream: file.byteStream(),
    fetchImpl: async (_address, options) => {
      setImmediate(() => { (async () => { for await (const chunk of options.body) void chunk; })().catch(() => {}); });
      return new Response(new ReadableStream({ cancel() { cancelled++; } }), { headers: { 'x-encrypted-param': 'fixture-receipt' } });
    },
  });
  assert.deepEqual(result, { encryptedParam: 'fixture-receipt' });
  assert.equal(cancelled, 1);
});

test('JSON bodies get a media type while explicit caller headers remain authoritative', async () => {
  for (const [headers, expected] of [[{}, 'application/json'], [{ 'content-type': 'application/custom+json' }, 'application/custom+json']]) {
    await platformJson(url, { hosts, method: 'POST', body: { value: 'fixture' }, headers,
      fetchImpl: async (_address, options) => {
        assert.equal(new Headers(options.headers).get('content-type'), expected);
        assert.equal(options.body, '{"value":"fixture"}');
        return new Response('{}');
      },
    });
  }
});

test('binary upload requires the iterable supplied by the real encryption caller before external I/O', async () => {
  let calls = 0;
  await assert.rejects(platformBinaryUpload(url, { hosts, expectedBytes: 1, byteStream: undefined,
    fetchImpl: async () => { calls++; } }), /INVALID_UPLOAD_FILE/);
  assert.equal(calls, 0);
});
