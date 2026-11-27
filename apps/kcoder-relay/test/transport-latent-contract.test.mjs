// Public Stream contracts with owned local resources, not a browser incident.
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { Duplex, PassThrough } from 'node:stream';
import test from 'node:test';
import { RelayDuplex } from '../src/transport.mjs';

async function bounded(promise, ms = 2000) {
  let timer;
  try {
    return await Promise.race([promise, new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error('owned stream contract deadline')), ms);
    })]);
  } finally { clearTimeout(timer); }
}
const turn = () => new Promise(resolve => setImmediate(resolve));
const closed = stream => stream.closed ? Promise.resolve() : new Promise(resolve => stream.once('close', resolve));

test('a naturally closed source rejects attach and settles queued writes and its owner once', async t => {
  const source = new PassThrough(), tunnel = new RelayDuplex();
  t.after(() => { source.destroy(); tunnel.destroy(); });
  source.on('error', () => {}); tunnel.on('error', () => {});
  source.resume(); source.end(); await bounded(closed(source));
  let connects = 0, releases = 0, callbacks = 0;
  tunnel.on('connect', () => connects++);
  const writes = [0, 1, 2].map(() => new Promise(resolve => {
    tunnel.write(Buffer.alloc(32 * 1024), error => { callbacks++; resolve(error); });
  }));
  assert.equal(tunnel.attach(source, () => releases++), false);
  const errors = await bounded(Promise.all(writes));
  await bounded(closed(tunnel)); await turn();
  assert.ok(errors.every(error => error instanceof Error));
  assert.equal(callbacks, 3); assert.equal(connects, 0); assert.equal(releases, 1);
});

for (const half of ['readable', 'writable']) {
  test(`an already ended ${half} rejects attach even before source destruction`, async t => {
    const source = new Duplex({ autoDestroy: false, read() {}, write(_chunk, _encoding, callback) { callback(); } });
    const tunnel = new RelayDuplex();
    t.after(() => { source.destroy(); tunnel.destroy(); });
    source.on('error', () => {}); tunnel.on('error', () => {});
    if (half === 'readable') {
      const ended = once(source, 'end'); source.resume(); source.push(null); await bounded(ended);
    } else {
      const finished = once(source, 'finish'); source.end(); await bounded(finished);
    }
    assert.equal(source.destroyed, false, 'the public half-close, not a mutated private field, is the gate');
    let releases = 0, callbacks = 0;
    const ended = new Promise(resolve => tunnel.end(error => { callbacks++; resolve(error); }));
    assert.equal(tunnel.attach(source, () => releases++), false);
    assert.ok(await bounded(ended) instanceof Error);
    await bounded(closed(tunnel)); await turn();
    assert.equal(callbacks, 1); assert.equal(releases, 1); assert.equal(source.destroyed, true);
  });
}

test('a rejected second attach releases only its candidate owner', async t => {
  const source = new PassThrough(), candidate = new PassThrough(), tunnel = new RelayDuplex();
  t.after(() => { source.destroy(); candidate.destroy(); tunnel.destroy(); });
  for (const stream of [source, candidate, tunnel]) stream.on('error', () => {});
  tunnel.resume();
  const received = []; source.on('data', chunk => received.push(Buffer.from(chunk)));
  let originalReleases = 0, candidateReleases = 0;
  assert.equal(tunnel.attach(source, () => originalReleases++), true);
  assert.equal(tunnel.attach(source, () => originalReleases++), false);
  assert.equal(source.destroyed, false, 'the same active source is still owned by the first attach');
  assert.equal(tunnel.attach(candidate, () => candidateReleases++), false);
  await bounded(closed(candidate));
  assert.equal(candidateReleases, 1); assert.equal(originalReleases, 0);
  assert.equal(tunnel.destroyed, false);
  await bounded(new Promise((resolve, reject) => tunnel.write('original-owner', error => error ? reject(error) : resolve())));
  assert.equal(Buffer.concat(received).toString(), 'original-owner');
  tunnel.destroy(); await bounded(closed(tunnel)); await turn();
  assert.equal(originalReleases, 1); assert.equal(candidateReleases, 1);
});

test('an empty pre-attach end waits for the actual source FIN receipt', async t => {
  const source = new PassThrough(), tunnel = new RelayDuplex();
  t.after(() => { source.destroy(); tunnel.destroy(); });
  source.on('error', () => {}); tunnel.on('error', () => {}); tunnel.resume();
  let callbacks = 0, finishes = 0, releases = 0;
  tunnel.on('finish', () => finishes++);
  const ended = new Promise(resolve => tunnel.end(error => { callbacks++; resolve(error); }));
  await turn();
  assert.equal(callbacks, 0); assert.equal(finishes, 0, 'FIN cannot complete before an upstream exists');
  assert.equal(tunnel.attach(source, () => releases++), true);
  assert.ifError(await bounded(ended));
  await bounded(closed(tunnel)); await turn();
  assert.equal(source.writableEnded, true); assert.equal(source.writableFinished, true);
  assert.equal(callbacks, 1); assert.equal(finishes, 1); assert.equal(releases, 1);
});

test('an attached empty FIN waits for the upstream final callback', async t => {
  let completeFinal, sawFinal;
  const finalStarted = new Promise(resolve => { sawFinal = resolve; });
  const source = new Duplex({ read() {}, write(_chunk, _encoding, callback) { callback(); },
    final(callback) { completeFinal = () => { this.push(null); callback(); }; sawFinal(); } });
  const tunnel = new RelayDuplex();
  t.after(() => { source.destroy(); tunnel.destroy(); });
  source.on('error', () => {}); tunnel.on('error', () => {}); tunnel.resume();
  let callbacks = 0;
  const ended = new Promise(resolve => tunnel.end(error => { callbacks++; resolve(error); }));
  assert.equal(tunnel.attach(source), true);
  await bounded(finalStarted); await turn();
  assert.equal(callbacks, 0, 'calling end is not a completed FIN receipt');
  completeFinal();
  assert.ifError(await bounded(ended));
  await bounded(closed(tunnel)); await turn();
  assert.equal(callbacks, 1); assert.equal(source.writableFinished, true);
});

test('destroy settles an unattached empty final once and releases a later candidate', async t => {
  const source = new PassThrough(), tunnel = new RelayDuplex();
  t.after(() => { source.destroy(); tunnel.destroy(); });
  source.on('error', () => {}); tunnel.on('error', () => {});
  const reason = new Error('owned fixture cancellation');
  let callbacks = 0, finishes = 0, releases = 0;
  tunnel.on('finish', () => finishes++);
  const ended = new Promise(resolve => tunnel.end(error => { callbacks++; resolve(error); }));
  await turn(); tunnel.destroy(reason);
  assert.equal(await bounded(ended), reason);
  await bounded(closed(tunnel));
  assert.equal(tunnel.attach(source, () => releases++), false);
  await bounded(closed(source)); await turn();
  assert.equal(callbacks, 1); assert.equal(finishes, 0); assert.equal(releases, 1);
});
