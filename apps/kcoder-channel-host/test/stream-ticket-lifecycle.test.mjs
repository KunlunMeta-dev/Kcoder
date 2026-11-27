import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { setImmediate as nextTurn } from 'node:timers/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { StreamTickets, privateTicketSource } from '../src/stream-tickets.mjs';
import { publicError } from '../src/errors.mjs';

function deferred() {
  let resolve;
  const promise = new Promise(accept => { resolve = accept; });
  return { promise, resolve };
}
async function within(promise) {
  let timer;
  try {
    return await Promise.race([promise, new Promise((_, reject) => {
      timer = setTimeout(() => reject(Object.assign(Error('fixture deadline'), { code: 'TEST_DEADLINE' })), 500);
    })]);
  } finally { clearTimeout(timer); }
}
function source(data, { chunks = data.length ? [data] : [], onNext, onDispose, ...metadata } = {}) {
  const calls = { next: 0, dispose: 0, returned: 0 };
  const iterator = {
    [Symbol.asyncIterator]() { return this; },
    async next() {
      const index = calls.next++;
      return onNext ? onNext(index) : index < chunks.length ? { done: false, value: chunks[index] } : { done: true };
    },
    async return() { calls.returned++; return { done: true }; },
  };
  return { calls, value: { filename: 'owned.bin', mediaType: 'application/octet-stream',
    expectedBytes: data.length, sha256: createHash('sha256').update(data).digest('hex'), ...metadata,
    byteStream: iterator, async dispose() { calls.dispose++; await onDispose?.(); } } };
}
function client(tickets, ticket, options = {}) {
  let closes = 0;
  const value = privateTicketSource((method, payload) => {
    if (method === 'read') return tickets.read(payload.owner, payload.streamId, payload.index);
    closes++; return tickets.close(payload.owner, payload.streamId);
  }, { owner: 'owner', ticket, ...options });
  return { value, closes: () => closes };
}

test('malformed declared metadata is rejected before source ownership is accepted', async () => {
  for (const metadata of [{ expectedBytes: -1 }, { expectedBytes: 'one' }, { expectedBytes: NaN },
    { sha256: 'not-a-digest' }, { sha256: 12 }, { filename: 'bad\0name' }, { mediaType: 12 }]) {
    const tickets = new StreamTickets(), f = source(Buffer.from('x'), metadata);
    await assert.rejects(tickets.open('owner', f.value), { code: 'WORKER_STREAM_INVALID' });
    assert.equal(f.calls.next, 0); assert.equal(f.calls.dispose, 0); assert.equal(tickets.reserved, 0);
  }
});

test('completed pulls release source chunks before the whole transfer is closed', async () => {
  const module = new URL('../src/stream-tickets.mjs', import.meta.url).href;
  const script = `import { StreamTickets } from ${JSON.stringify(module)};
    import { setImmediate as turn } from 'node:timers/promises';
    const references=[];let count=0;
    const iterator={ [Symbol.asyncIterator](){return this;},async next(){
      count++;const value=Buffer.alloc(65536,count);references.push(new WeakRef(value));return {done:false,value};
    }};
    const tickets=new StreamTickets();
    const ticket=await tickets.open('owner',{filename:'bounded.bin',expectedBytes:80*65536,byteStream:iterator});
    for(let index=0;index<80;index++)await tickets.read('owner',ticket.streamId,index);
    for(let pass=0;pass<4;pass++){await turn();global.gc();}
    await turn();const alive=references.filter(reference=>reference.deref()!==undefined).length;
    await tickets.closeAll();console.log(JSON.stringify({alive,produced:count}));`;
  const result = await promisify(execFile)(process.execPath, ['--expose-gc', '--input-type=module', '-e', script], { timeout: 5000 });
  const observed = JSON.parse(result.stdout);
  assert.equal(observed.produced, 80);
  assert.ok(observed.alive <= 2, `completed pulls still retain ${observed.alive} source chunks`);
});

test('the private client releases completed IPC frames while a transfer remains open', async () => {
  const module = new URL('../src/stream-tickets.mjs', import.meta.url).href;
  const script = `import { privateTicketSource } from ${JSON.stringify(module)};
    import { setImmediate as turn } from 'node:timers/promises';
    const references=[];let count=0;
    const source=privateTicketSource(async(method,request)=>{
      if(method==='close')return {closed:true};
      count++;const frame={streamId:'owned',index:request.index,done:false,contentBase64:Buffer.alloc(65536,count).toString('base64')};
      references.push(new WeakRef(frame));return frame;
    },{owner:'owner',ticket:{streamId:'owned',filename:'bounded.bin',expectedBytes:160*65536}});
    for(let index=0;index<80;index++)await source.byteStream.next();
    for(let pass=0;pass<4;pass++){await turn();global.gc();}
    await turn();const alive=references.filter(reference=>reference.deref()!==undefined).length;
    await source.dispose();await source.byteStream.return();console.log(JSON.stringify({alive,produced:count}));`;
  const result = await promisify(execFile)(process.execPath, ['--expose-gc', '--input-type=module', '-e', script], { timeout: 5000 });
  const observed = JSON.parse(result.stdout);
  assert.equal(observed.produced, 80);
  assert.ok(observed.alive <= 2, `completed reads still retain ${observed.alive} IPC frames`);
});

test('a caller cannot redirect the original read or cleanup by mutating its ticket', async () => {
  const started = deferred(), pull = deferred(), calls = [];
  const ticket = { streamId: 'original', filename: 'owned.bin', expectedBytes: 0 };
  const c = privateTicketSource((method, request) => {
    calls.push({ method, streamId: request.streamId });
    if (method === 'read') { started.resolve(); return pull.promise; }
    return Promise.resolve({ closed: true });
  }, { owner: 'owner', ticket });
  const reading = c.byteStream.next(); await started.promise; ticket.streamId = 'replacement';
  pull.resolve({ streamId: 'original', index: 0, done: true, bytes: 0, sha256: createHash('sha256').digest('hex') });
  assert.equal((await reading).done, true);
  await c.dispose(); assert.deepEqual(calls, [{ method: 'read', streamId: 'original' }, { method: 'close', streamId: 'original' }]);
});

test('admission captures the original source and disposer before awaiting expiry cleanup', async () => {
  const original = source(Buffer.from('original')), replacement = source(Buffer.from('replacement'));
  const tickets = new StreamTickets(), pending = tickets.open('owner', original.value);
  original.value.byteStream = replacement.value.byteStream;
  original.value.dispose = replacement.value.dispose;
  const c = client(tickets, await pending), parts = [];
  for await (const part of c.value.byteStream) parts.push(part);
  assert.equal(Buffer.concat(parts).toString(), 'original');
  assert.equal(original.calls.dispose, 1); assert.equal(replacement.calls.dispose, 0); assert.equal(replacement.calls.next, 0);
});

test('a valid read renews its lease before pulling and after producing a chunk', async () => {
  let now = 1;
  const started = deferred(), pull = deferred();
  const f = source(Buffer.from('x'), { onNext: () => { started.resolve(); return pull.promise; } });
  const tickets = new StreamTickets({ ttlMs: 10, now: () => now }), ticket = await tickets.open('owner', f.value);
  now = 8; const reading = tickets.read('owner', ticket.streamId, 0); const observed = reading.catch(error => error);
  await started.promise; now = 12;
  try {
    await tickets.reap();
    assert.equal(f.calls.dispose, 0);
  } finally { pull.resolve({ done: false, value: Buffer.from('x') }); }
  assert.equal((await observed).done, false);
  now = 20; assert.equal(tickets.get('owner', ticket.streamId).owner, 'owner');
  await tickets.closeAll();
});

test('finite empty source chunks do not produce empty wire frames', async () => {
  const f = source(Buffer.from('x'), { chunks: [Buffer.alloc(0), Buffer.alloc(0), Buffer.from('x')] });
  const tickets = new StreamTickets(), ticket = await tickets.open('owner', f.value), c = client(tickets, ticket);
  const parts = []; for await (const part of c.value.byteStream) parts.push(part);
  assert.equal(parts.length, 1); assert.equal(Buffer.concat(parts).toString(), 'x');
  assert.equal(f.calls.dispose, 1); assert.equal(f.calls.returned, 1);
});

test('a producer cannot keep one read alive by returning empty chunks indefinitely', async () => {
  const f = source(Buffer.alloc(0), { onNext: () => ({ done: false, value: Buffer.alloc(0) }) });
  const tickets = new StreamTickets(), ticket = await tickets.open('owner', f.value);
  await assert.rejects(within(tickets.read('owner', ticket.streamId, 0)), { code: 'WORKER_STREAM_SOURCE_STALLED' });
  assert.ok(f.calls.next <= 64); assert.equal(f.calls.dispose, 1); assert.equal(f.calls.returned, 1);
  assert.equal(tickets.reserved, 0); await tickets.closeAll();
});

test('cleanup failure preserves even a frozen or non-Error original rejection', async () => {
  for (const original of [Object.freeze(Error('private original')), null, 0, '']) {
    let closes = 0;
    const c = privateTicketSource(method => {
      if (method === 'read') return Promise.reject(original);
      closes++; return Promise.reject(Error('private cleanup'));
    }, { owner: 'owner', ticket: { streamId: 'owned', filename: 'file.bin' } });
    const observed = await c.byteStream.next().then(() => ({ resolved: true }), reason => ({ failed: true, reason }));
    assert.equal(observed.failed, true); assert.equal(observed.reason, original);
    await assert.rejects(c.dispose(), { code: 'WORKER_STREAM_CLEANUP_UNCONFIRMED' }); assert.equal(closes, 1);
  }
});

test('a rejected chunk is terminal and cannot consume later bytes on an index retry', async () => {
  const f = source(Buffer.from('x'), { chunks: [Buffer.from('too long'), Buffer.from('x')] });
  const tickets = new StreamTickets(), ticket = await tickets.open('owner', f.value);
  await assert.rejects(tickets.read('owner', ticket.streamId, 0), { code: 'WORKER_STREAM_LENGTH_MISMATCH' });
  await assert.rejects(tickets.read('owner', ticket.streamId, 0), { code: 'WORKER_STREAM_LENGTH_MISMATCH' });
  assert.equal(f.calls.next, 1); assert.equal(f.calls.dispose, 1); assert.equal(f.calls.returned, 1);
  assert.equal(tickets.reserved, 0);
  await tickets.closeAll();
});

test('hash failure retains its original domain error instead of finalizing the hash twice', async () => {
  const f = source(Buffer.from('bytes'), { sha256: '0'.repeat(64) });
  const tickets = new StreamTickets(), ticket = await tickets.open('owner', f.value);
  await tickets.read('owner', ticket.streamId, 0);
  for (let attempt = 0; attempt < 2; attempt++)
    await assert.rejects(tickets.read('owner', ticket.streamId, 1), { code: 'WORKER_STREAM_HASH_MISMATCH' });
  assert.equal(f.calls.next, 2); assert.equal(f.calls.dispose, 1); assert.equal(f.calls.returned, 1);
  assert.equal(tickets.reserved, 0); await tickets.closeAll();
});

test('a completed receipt replays without reopening the iterator or repeating cleanup', async () => {
  const f = source(Buffer.alloc(0)), tickets = new StreamTickets({ maxStreams: 1 });
  const ticket = await tickets.open('owner', f.value), done = await tickets.read('owner', ticket.streamId, 0);
  assert.equal(done.done, true);
  assert.deepEqual(await tickets.read('owner', ticket.streamId, 0), done);
  await assert.rejects(tickets.read('owner', ticket.streamId, 1), { code: 'WORKER_STREAM_INDEX_CONFLICT' });
  assert.equal(f.calls.dispose, 1); assert.equal(f.calls.returned, 1); assert.equal(tickets.reserved, 0);
  const other = await tickets.open('owner', source(Buffer.from('next')).value);
  await tickets.close('owner', other.streamId); await tickets.closeAll();
});

test('receipt capacity applies backpressure instead of evicting an unexpired original outcome', async () => {
  const tickets = new StreamTickets({ maxStreams: 1 });
  const first = await tickets.open('owner', source(Buffer.alloc(0)).value);
  const original = await tickets.read('owner', first.streamId, 0);
  const second = await tickets.open('owner', source(Buffer.alloc(0)).value);
  await tickets.read('owner', second.streamId, 0);
  assert.deepEqual(await tickets.read('owner', first.streamId, 0), original);
  await assert.rejects(tickets.open('owner', source(Buffer.alloc(0)).value), { code: 'MEDIA_CAPACITY_EXCEEDED' });
  await tickets.close('owner', first.streamId);
  const third = await tickets.open('owner', source(Buffer.alloc(0)).value);
  await tickets.close('owner', third.streamId); await tickets.closeAll();
});

test('close fences a pending read and holds its reservation until the original source settles', async () => {
  const started = deferred(), pull = deferred();
  const f = source(Buffer.from('late'), { onNext: () => { started.resolve(); return pull.promise; } });
  const tickets = new StreamTickets(), ticket = await tickets.open('owner', f.value);
  const reading = tickets.read('owner', ticket.streamId, 0);
  const observation = reading.then(value => ({ value }), error => ({ error }));
  await started.promise;
  const closing = tickets.close('owner', ticket.streamId);
  try {
    assert.equal(tickets.reserved, 4);
    const result = await within(observation); assert.equal(result.error?.code, 'WORKER_STREAM_CLOSED');
    assert.equal(f.calls.dispose, 1); assert.equal(f.calls.returned, 1);
  } finally { pull.resolve({ done: false, value: Buffer.from('late') }); await closing; }
  assert.equal(tickets.reserved, 0); assert.equal(f.calls.returned, 1);
  assert.equal((await observation).value, undefined);
});

test('cleanup attempts each independent hook once and reports an unconfirmed close honestly', async () => {
  const f = source(Buffer.from('x'), { onDispose: () => { throw Error('PRIVATE_STREAM_CANARY'); } });
  const tickets = new StreamTickets(), ticket = await tickets.open('owner', f.value);
  let first;
  for (let attempt = 0; attempt < 2; attempt++) {
    await assert.rejects(tickets.close('owner', ticket.streamId), error => {
      assert.equal(error.code, 'WORKER_STREAM_CLEANUP_UNCONFIRMED');
      assert.ok(!JSON.stringify(publicError(error)).includes('PRIVATE_STREAM_CANARY'));
      if (first) assert.equal(error, first); else first = error;
      return true;
    });
  }
  assert.equal(f.calls.dispose, 1); assert.equal(f.calls.returned, 1); assert.equal(tickets.reserved, 1);
});

test('one failed expired close cannot prevent another owner from being reclaimed', async () => {
  let now = 1;
  const tickets = new StreamTickets({ ttlMs: 10, now: () => now });
  const bad = source(Buffer.from('x'), { onDispose: () => { throw Error('private cleanup failure'); } });
  const good = source(Buffer.from('y'));
  await tickets.open('first-owner', bad.value); const second = await tickets.open('second-owner', good.value);
  now = 12;
  await assert.rejects(tickets.reap(), { code: 'WORKER_STREAM_CLEANUP_UNCONFIRMED' });
  assert.equal(good.calls.dispose, 1); assert.equal(good.calls.returned, 1); assert.equal(tickets.reserved, 1);
  assert.deepEqual(await tickets.close('second-owner', second.streamId), { closed: true });
});

test('new admission lazily reclaims expired resources while invalid reads cannot renew a lease', async () => {
  let now = 1;
  const tickets = new StreamTickets({ maxStreams: 1, maxReservedBytes: 1, ttlMs: 10, now: () => now });
  const old = source(Buffer.from('x')), first = await tickets.open('owner', old.value);
  now = 8; await assert.rejects(tickets.read('owner', first.streamId, 9), { code: 'WORKER_STREAM_INDEX_CONFLICT' });
  now = 12; const second = await tickets.open('owner', source(Buffer.from('y')).value);
  assert.equal(old.calls.dispose, 1); assert.equal(old.calls.returned, 1); assert.equal(tickets.reserved, 1);
  await tickets.close('owner', second.streamId);
});

test('unknown metadata and uppercase digests round trip through both private stream peers', async () => {
  for (const metadata of [{ expectedBytes: null, sha256: null }, { sha256: createHash('sha256').update('bytes').digest('hex').toUpperCase() }]) {
    const tickets = new StreamTickets(), f = source(Buffer.from('bytes'), metadata);
    const ticket = await tickets.open('owner', f.value);
    const c = client(tickets, { ...ticket, sha256: ticket.sha256?.toUpperCase() ?? null });
    const parts = []; for await (const part of c.value.byteStream) parts.push(part);
    await c.value.dispose();
    assert.equal(Buffer.concat(parts).toString(), 'bytes');
    assert.equal(c.closes(), 1); assert.equal(f.calls.dispose, 1); assert.equal(f.calls.returned, 1);
  }
});

test('abort interrupts a pending IPC read and reconciles exactly one close', async () => {
  const controller = new AbortController(), started = deferred(); let closes = 0;
  const c = privateTicketSource((method) => {
    if (method === 'read') { started.resolve(); return new Promise(() => {}); }
    closes++; return Promise.resolve({ closed: true });
  }, { owner: 'owner', ticket: { streamId: 'owned', filename: 'file.bin' }, signal: controller.signal });
  const reading = c.byteStream.next(); await started.promise; controller.abort();
  await assert.rejects(within(reading), { name: 'AbortError' });
  await c.dispose(); assert.equal(closes, 1);
});

test('explicit client disposal interrupts its own pending read and shares the close receipt', async () => {
  const started = deferred(); let closes = 0;
  const c = privateTicketSource(method => {
    if (method === 'read') { started.resolve(); return new Promise(() => {}); }
    closes++; return Promise.resolve({ closed: true });
  }, { owner: 'owner', ticket: { streamId: 'owned', filename: 'file.bin' } });
  const reading = c.byteStream.next(); await started.promise; await c.dispose();
  await assert.rejects(within(reading), { code: 'WORKER_STREAM_CLOSED' });
  await c.dispose(); assert.equal(closes, 1);
});

test('a missing close receipt is bounded and never converted to a successful disposal', async () => {
  let closes = 0;
  const c = privateTicketSource(() => { closes++; return new Promise(() => {}); },
    { owner: 'owner', ticket: { streamId: 'owned', filename: 'file.bin' }, cleanupTimeoutMs: 25 });
  for (let attempt = 0; attempt < 2; attempt++)
    await assert.rejects(within(c.dispose()), { code: 'WORKER_STREAM_CLEANUP_UNCONFIRMED' });
  assert.equal(closes, 1);
});

test('a timed-out source cleanup retains ownership and reconciles its late original completion', async () => {
  const started = deferred(), pull = deferred();
  const f = source(Buffer.from('x'), { onNext: () => { started.resolve(); return pull.promise; } });
  const tickets = new StreamTickets({ cleanupTimeoutMs: 25 }), ticket = await tickets.open('owner', f.value);
  const reading = tickets.read('owner', ticket.streamId, 0); const outcome = reading.catch(error => error);
  await started.promise;
  try {
    await assert.rejects(within(tickets.close('owner', ticket.streamId)), { code: 'WORKER_STREAM_CLEANUP_UNCONFIRMED' });
    assert.equal((await within(outcome)).code, 'WORKER_STREAM_CLOSED'); assert.equal(tickets.reserved, 1);
  } finally { pull.resolve({ done: false, value: Buffer.from('x') }); await nextTurn(); }
  assert.deepEqual(await tickets.close('owner', ticket.streamId), { closed: true });
  assert.equal(tickets.reserved, 0); assert.equal(f.calls.dispose, 1); assert.equal(f.calls.returned, 1);
});

test('an iterator return hook can interrupt its pending pull when no disposer exists', async () => {
  const started = deferred(), pull = deferred(); let returned = 0;
  const iterator = { [Symbol.asyncIterator]() { return this; },
    next() { started.resolve(); return pull.promise; },
    return() { returned++; pull.resolve({ done: true }); return Promise.resolve({ done: true }); } };
  const tickets = new StreamTickets({ cleanupTimeoutMs: 25 });
  const ticket = await tickets.open('owner', { filename: 'owned.bin', expectedBytes: 0, byteStream: iterator });
  const reading = tickets.read('owner', ticket.streamId, 0).catch(error => error);
  await started.promise;
  try {
    assert.deepEqual(await within(tickets.close('owner', ticket.streamId)), { closed: true });
    assert.equal((await reading).code, 'WORKER_STREAM_CLOSED');
    assert.equal(returned, 1); assert.equal(tickets.reserved, 0);
  } finally { pull.resolve({ done: true }); await nextTurn(); await tickets.closeAll(); }
});

test('a yielded cleanup value is not proof that the source iterator has closed', async () => {
  let finished = false;
  const iterator = (async function* () {
    try { yield Buffer.from('x'); }
    finally { yield Buffer.from('cleanup'); finished = true; }
  })();
  const tickets = new StreamTickets(), ticket = await tickets.open('owner',
    { filename: 'owned.bin', expectedBytes: 1, byteStream: iterator });
  await tickets.read('owner', ticket.streamId, 0);
  try {
    await assert.rejects(tickets.close('owner', ticket.streamId), { code: 'WORKER_STREAM_CLEANUP_UNCONFIRMED' });
    assert.equal(finished, false); assert.equal(tickets.reserved, 1);
  } finally { await iterator.next(); }
  assert.equal(finished, true);
});

test('the private client reconciles a late original close receipt without another RPC', async () => {
  const receipt = deferred(); let closes = 0;
  const c = privateTicketSource(() => { closes++; return receipt.promise; },
    { owner: 'owner', ticket: { streamId: 'owned', filename: 'owned.bin' }, cleanupTimeoutMs: 25 });
  await assert.rejects(c.dispose(), { code: 'WORKER_STREAM_CLEANUP_UNCONFIRMED' });
  receipt.resolve({ closed: true }); await nextTurn();
  assert.deepEqual(await c.dispose(), { closed: true }); assert.equal(closes, 1);
});

test('instance shutdown fences admissions already suspended before source acquisition', async () => {
  const tickets = new StreamTickets(), f = source(Buffer.from('owned'));
  const opening = tickets.open('owner', f.value);
  const outcome = opening.then(value => ({ value }), error => ({ error }));
  await tickets.closeAll();
  try {
    const observed = await outcome;
    assert.equal(observed.error?.code, 'WORKER_STREAM_CLOSED');
    assert.equal(tickets.reserved, 0);
    assert.equal(f.calls.dispose, 0, 'rejected admission retains caller cleanup responsibility');
    assert.equal(f.calls.returned, 0);
  } finally { await tickets.closeAll(); }
});

test('a shut down instance rejects new admissions before invoking the original iterator factory', async () => {
  const tickets = new StreamTickets(); let factories = 0;
  const f = source(Buffer.from('owned'));
  const factory = f.value.byteStream[Symbol.asyncIterator];
  f.value.byteStream[Symbol.asyncIterator] = function () { factories++; return factory.call(this); };
  await tickets.closeAll();
  try {
    await assert.rejects(tickets.open('owner', f.value), { code: 'WORKER_STREAM_CLOSED' });
    assert.equal(factories, 0); assert.equal(f.calls.dispose, 0); assert.equal(tickets.reserved, 0);
  } finally { await tickets.closeAll(); }
});

test('shutdown while admission awaits expired cleanup cannot create a later owner', async () => {
  let now = 1;
  const releasing = deferred(), cleanupStarted = deferred();
  const tickets = new StreamTickets({ maxStreams: 1, maxReservedBytes: 1, ttlMs: 10, now: () => now });
  await tickets.open('old-owner', source(Buffer.from('x'), { onDispose: () => { cleanupStarted.resolve(); return releasing.promise; } }).value);
  now = 12;
  const next = source(Buffer.from('y')); let factories = 0;
  const original = next.value.byteStream[Symbol.asyncIterator];
  next.value.byteStream[Symbol.asyncIterator] = function () { factories++; return original.call(this); };
  const opening = tickets.open('new-owner', next.value).then(value => ({ value }), error => ({ error }));
  await cleanupStarted.promise;
  const closing = tickets.closeAll();
  releasing.resolve(); await closing;
  try {
    assert.equal((await opening).error?.code, 'WORKER_STREAM_CLOSED');
    assert.equal(factories, 0); assert.equal(tickets.reserved, 0);
  } finally { await tickets.closeAll(); }
});

test('client iterator return alone interrupts a pending read and reconciles exactly one close', async () => {
  const started = deferred(); let closes = 0;
  const c = privateTicketSource(method => {
    if (method === 'read') { started.resolve(); return new Promise(() => {}); }
    closes++; return Promise.resolve({ closed: true });
  }, { owner: 'owner', ticket: { streamId: 'owned', filename: 'owned.bin' } });
  const reading = c.byteStream.next().catch(error => error);
  await started.promise;
  try {
    assert.equal((await within(c.byteStream.return())).done, true);
    assert.equal((await reading).code, 'WORKER_STREAM_CLOSED');
    assert.equal(closes, 1);
  } finally { await c.dispose(); await reading; }
});

test('return-only async generator cleanup retains quota through both its original pull and finally', async () => {
  const started = deferred(), pull = deferred(), finishing = deferred(), releaseFinally = deferred();
  let returns = 0, finalizers = 0;
  const generator = (async function* () {
    try { started.resolve(); yield await pull.promise; }
    finally { finalizers++; finishing.resolve(); await releaseFinally.promise; }
  })();
  const iterator = { [Symbol.asyncIterator]() { return this; }, next: generator.next.bind(generator),
    return() { returns++; return generator.return(); } };
  const tickets = new StreamTickets({ maxStreams: 1, maxReservedBytes: 1, cleanupTimeoutMs: 25 });
  const ticket = await tickets.open('owner', { filename: 'owned.bin', expectedBytes: 1, byteStream: iterator });
  const reading = tickets.read('owner', ticket.streamId, 0).catch(error => error);
  await started.promise;
  try {
    await assert.rejects(within(tickets.close('owner', ticket.streamId)), { code: 'WORKER_STREAM_CLEANUP_UNCONFIRMED' });
    assert.equal((await within(reading)).code, 'WORKER_STREAM_CLOSED');
    assert.equal(tickets.reserved, 1);
    pull.resolve(Buffer.from('x')); await finishing.promise;
    assert.equal(tickets.reserved, 1);
    await assert.rejects(tickets.open('other', source(Buffer.from('y')).value), { code: 'MEDIA_CAPACITY_EXCEEDED' });
    releaseFinally.resolve(); await nextTurn();
    assert.deepEqual(await tickets.close('owner', ticket.streamId), { closed: true });
    assert.equal(tickets.reserved, 0); assert.equal(returns, 1); assert.equal(finalizers, 1);
  } finally { pull.resolve(Buffer.from('x')); releaseFinally.resolve(); await nextTurn(); await tickets.closeAll(); }
});

test('failed instance shutdown still fences new owners and preserves unconfirmed quota', async () => {
  const tickets = new StreamTickets({ maxStreams: 1, maxReservedBytes: 1 });
  const f = source(Buffer.from('x'), { onDispose: () => { throw Error('owned cleanup failure'); } });
  await tickets.open('owner', f.value);
  await assert.rejects(tickets.closeAll(), { code: 'WORKER_STREAM_CLEANUP_UNCONFIRMED' });
  const other = source(Buffer.from('y')); let factories = 0;
  const original = other.value.byteStream[Symbol.asyncIterator];
  other.value.byteStream[Symbol.asyncIterator] = function () { factories++; return original.call(this); };
  await assert.rejects(tickets.open('peer', other.value), { code: 'WORKER_STREAM_CLOSED' });
  assert.equal(factories, 0); assert.equal(tickets.reserved, 1);
  assert.equal(f.calls.dispose, 1); assert.equal(f.calls.returned, 1);
});

test('client iterator return before its first pull closes the already owned ticket once', async () => {
  const methods = [];
  const c = privateTicketSource(method => { methods.push(method); return Promise.resolve({ closed: true }); },
    { owner: 'owner', ticket: { streamId: 'owned', filename: 'owned.bin' } });
  assert.equal((await c.byteStream.return()).done, true);
  await c.dispose(); assert.deepEqual(methods, ['close']);
  assert.equal((await c.byteStream.next()).done, true);
});

test('iterator-only cancellation keeps a lost close receipt unknown and reconciles its late result', async () => {
  const started = deferred(), receipt = deferred(); let closes = 0;
  const c = privateTicketSource(method => {
    if (method === 'read') { started.resolve(); return new Promise(() => {}); }
    closes++; return receipt.promise;
  }, { owner: 'owner', ticket: { streamId: 'owned', filename: 'owned.bin' }, cleanupTimeoutMs: 25 });
  const reading = c.byteStream.next().catch(error => error);
  await started.promise;
  try {
    await assert.rejects(within(c.byteStream.return()), { code: 'WORKER_STREAM_CLEANUP_UNCONFIRMED' });
    assert.equal((await within(reading)).code, 'WORKER_STREAM_CLOSED');
    await assert.rejects(c.byteStream.return(), { code: 'WORKER_STREAM_CLEANUP_UNCONFIRMED' });
    assert.equal(closes, 1);
    receipt.resolve({ closed: true }); await nextTurn();
    assert.equal((await c.byteStream.return()).done, true);
    await c.dispose(); assert.equal(closes, 1);
  } finally { receipt.resolve({ closed: true }); await c.dispose(); await reading; }
});

test('synchronous factory shutdown closes the iterator already acquired by this admission', async () => {
  const tickets = new StreamTickets(), f = source(Buffer.from('x'));
  const original = f.value.byteStream[Symbol.asyncIterator]; let closing, factories = 0;
  f.value.byteStream[Symbol.asyncIterator] = function () {
    factories++; closing = tickets.closeAll(); return original.call(this);
  };
  await assert.rejects(tickets.open('owner', f.value), { code: 'WORKER_STREAM_CLOSED' });
  await closing;
  assert.equal(factories, 1); assert.equal(f.calls.next, 0);
  assert.equal(f.calls.dispose, 1); assert.equal(f.calls.returned, 1); assert.equal(tickets.reserved, 0);
});

test('synchronous factory shutdown retains uncertain acquired cleanup without repeating hooks', async () => {
  const disposal = deferred(), tickets = new StreamTickets({ maxStreams: 1, maxReservedBytes: 1, cleanupTimeoutMs: 25 });
  const f = source(Buffer.from('x'), { onDispose: () => disposal.promise });
  const original = f.value.byteStream[Symbol.asyncIterator]; let closing;
  f.value.byteStream[Symbol.asyncIterator] = function () {
    closing = tickets.closeAll().then(value => ({ value }), error => ({ error }));
    return original.call(this);
  };
  try {
    const rejected = await tickets.open('owner', f.value).catch(error => error);
    assert.equal(rejected.code, 'WORKER_STREAM_CLOSED');
    assert.equal(rejected.cleanupError?.code, 'WORKER_STREAM_CLEANUP_UNCONFIRMED');
    assert.equal((await closing).error?.code, 'WORKER_STREAM_CLEANUP_UNCONFIRMED');
    assert.equal(tickets.reserved, 1); assert.equal(f.calls.dispose, 1); assert.equal(f.calls.returned, 1);
    disposal.resolve(); await nextTurn();
    await tickets.closeAll(); assert.equal(tickets.reserved, 0);
    assert.equal(f.calls.dispose, 1); assert.equal(f.calls.returned, 1);
  } finally { disposal.resolve(); await nextTurn(); await tickets.closeAll(); }
});

test('pre-factory capacity rejection never takes over an unadmitted caller source', async () => {
  const tickets = new StreamTickets({ maxStreams: 1, maxReservedBytes: 1 });
  const first = source(Buffer.from('x')), rejected = source(Buffer.from('y')); let factories = 0;
  const original = rejected.value.byteStream[Symbol.asyncIterator];
  rejected.value.byteStream[Symbol.asyncIterator] = function () { factories++; return original.call(this); };
  await tickets.open('owner', first.value);
  try {
    await assert.rejects(tickets.open('peer', rejected.value), { code: 'MEDIA_CAPACITY_EXCEEDED' });
    assert.equal(factories, 0); assert.equal(rejected.calls.dispose, 0); assert.equal(rejected.calls.returned, 0);
    assert.equal(tickets.reserved, 1);
  } finally { await tickets.closeAll(); }
});

test('factory failure keeps its original cause and registry-owned disposer outcome observable', async () => {
  const tickets = new StreamTickets(), f = source(Buffer.from('x'));
  const originalError = Object.freeze(Error('PRIVATE_FACTORY_FAILURE')); let closing;
  f.value.byteStream[Symbol.asyncIterator] = function () {
    closing = tickets.closeAll().then(value => ({ value }), error => ({ error }));
    throw originalError;
  };
  const error = await tickets.open('owner', f.value).catch(error => error);
  assert.equal(error.code, 'WORKER_STREAM_SOURCE_FAILED'); assert.equal(error.recovery, 'reconcile_original');
  assert.equal(error.cause, originalError); assert.equal(Object.isFrozen(originalError), true);
  assert.equal(JSON.stringify(publicError(error)).includes('PRIVATE_FACTORY_FAILURE'), false);
  assert.equal((await closing).error, undefined);
  assert.equal(f.calls.dispose, 1); assert.equal(f.calls.returned, 0); assert.equal(tickets.reserved, 0);
});

test('factory failure with no cleanup receipt retains the acquired reservation as unknown', async () => {
  const tickets = new StreamTickets({ maxStreams: 1, maxReservedBytes: 1 }); let closing, factories = 0;
  const value = { filename: 'owned.bin', expectedBytes: 1, byteStream: {
    [Symbol.asyncIterator]() {
      factories++; closing = tickets.closeAll().then(value => ({ value }), error => ({ error }));
      throw Error('owned factory failure after entry');
    },
  } };
  const error = await tickets.open('owner', value).catch(error => error);
  assert.equal(error.code, 'WORKER_STREAM_SOURCE_FAILED'); assert.equal(error.recovery, 'reconcile_original');
  assert.equal(error.cleanupError?.code, 'WORKER_STREAM_CLEANUP_UNCONFIRMED');
  assert.equal((await closing).error?.code, 'WORKER_STREAM_CLEANUP_UNCONFIRMED');
  assert.equal(tickets.reserved, 1); assert.equal(factories, 1);
  await assert.rejects(tickets.closeAll(), { code: 'WORKER_STREAM_CLEANUP_UNCONFIRMED' });
  assert.equal(factories, 1); assert.equal(tickets.reserved, 1);
});

for (const outcome of ['yielded', 'rejected']) test(`factory reentrant shutdown retains quota after acquired iterator cleanup ${outcome}`, async () => {
  const tickets = new StreamTickets({ maxStreams: 1, maxReservedBytes: 1 }), f = source(Buffer.from('x')); let closing;
  const iterator = f.value.byteStream;
  iterator.return = async () => {
    f.calls.returned++;
    if (outcome === 'rejected') throw Error('owned return failure');
    return { done: false, value: Buffer.from('unfinished cleanup') };
  };
  const original = iterator[Symbol.asyncIterator];
  iterator[Symbol.asyncIterator] = function () {
    closing = tickets.closeAll().then(value => ({ value }), error => ({ error }));
    return original.call(this);
  };
  const error = await tickets.open('owner', f.value).catch(error => error);
  assert.equal(error.code, 'WORKER_STREAM_CLOSED'); assert.equal(error.recovery, 'reconcile_original');
  assert.equal(error.cleanupError?.code, 'WORKER_STREAM_CLEANUP_UNCONFIRMED');
  assert.equal((await closing).error?.code, 'WORKER_STREAM_CLEANUP_UNCONFIRMED');
  assert.equal(tickets.reserved, 1); assert.equal(f.calls.dispose, 1); assert.equal(f.calls.returned, 1);
  await assert.rejects(tickets.closeAll(), { code: 'WORKER_STREAM_CLEANUP_UNCONFIRMED' });
  assert.equal(tickets.reserved, 1); assert.equal(f.calls.dispose, 1); assert.equal(f.calls.returned, 1);
});
