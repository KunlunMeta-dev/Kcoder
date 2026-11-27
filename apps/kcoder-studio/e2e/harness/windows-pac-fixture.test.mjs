import test from 'node:test';
import assert from 'node:assert/strict';
import { Script, createContext } from 'node:vm';
import { RunContext } from './run-context.mjs';
import { startWindowsPacFixture, WINDOWS_PAC_TESTS } from './windows-pac-fixture.mjs';

test('owned PAC fixture routes exact original URLs, serves explicit failures and cleans only its sockets', async () => {
  const context = await RunContext.create(import.meta.url, { testId: 'owned-pac-fixture', tier: 'model-independent', modelPolicy: 'loopback PAC script contract only; JavaScript VM is not WinHTTP acceptance, no model or public network' });
  let failure;
  try {
    const owned = await startWindowsPacFixture(context), peer = await startWindowsPacFixture(context);
    const f = owned.fixture;
    assert.equal(owned.stats().pacRequests, 0, 'startup must not fetch a PAC');
    assert.equal(WINDOWS_PAC_TESTS.length, 5);
    const body = await (await fetch(f.pacUrl)).text();
    const sandbox = createContext({}); new Script(body).runInContext(sandbox, { timeout: 100 });
    const route = url => sandbox.FindProxyForURL(url, new URL(url).hostname);
    assert.equal(route(f.urls.a), `PROXY ${new URL(f.proxyA).host}`);
    assert.equal(route(f.urls.b), `PROXY ${new URL(f.proxyB).host}`);
    assert.equal(route(f.urls.secureA), `PROXY ${new URL(f.proxyA).host}`);
    assert.equal(route(f.urls.secureB), `PROXY ${new URL(f.proxyB).host}`);
    assert.equal(route(f.urls.direct), 'DIRECT');
    assert.equal((await fetch(f.missingPacUrl)).status, 404);
    assert.throws(() => new Script('function FindProxyForURL( {'), SyntaxError);
    const slow = await fetch(f.slowPacUrl); assert.equal(slow.status, 200);
    const before = await (await fetch(f.statsUrl)).json();
    assert.equal(before.slowPacRequests, 1); assert.ok(before.activeSockets >= 1); assert.equal(before.proxyConnections, 0);
    const stopped = await owned.stop();
    assert.equal(stopped.activeSockets, 0); assert.equal(stopped.closed, true);
    await assert.rejects(slow.text());
    assert.equal((await fetch(peer.fixture.pacUrl)).status, 200, 'owner cleanup must preserve the peer');
    assert.deepEqual(await owned.stop(), stopped, 'cleanup must be idempotent');
  } catch (error) { failure = error; throw error; }
  finally { await context.finish(failure ? 'failed' : 'passed', {}, failure); }
});
