import assert from 'node:assert/strict';
import { request as requestHttp, Agent } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { connect as connectTls } from 'node:tls';
import { Script, createContext } from 'node:vm';
import test from 'node:test';
import { RunContext } from './run-context.mjs';
import { prepareWindowsManagedPacCertificates } from './windows-managed-pac-certificates.mjs';
import { startWindowsManagedPacFixture, windowsManagedPacPayload, WINDOWS_MANAGED_PAC_HOST } from './windows-managed-pac-fixture.mjs';

async function input(context) {
  const prepared = await prepareWindowsManagedPacCertificates(context);
  return { fixtureId: prepared.fixtureId, caPem: await readFile(prepared.caPath), certificatePem: await readFile(prepared.certificatePath), privateKeyPem: await readFile(prepared.keyPath), allowedConnectAddresses: ['13.107.21.200', '2606:4700:4700::1111'] };
}
function tunnel(context, fixture, destination) {
  const proxy = new URL(fixture.proxyUrl);
  return new Promise((resolve, reject) => {
    const request = requestHttp({ hostname: proxy.hostname, port: proxy.port, method: 'CONNECT', path: destination });
    request.once('error', reject);
    request.once('connect', (response, socket) => { context.addCleanup('close owned CONNECT test socket', () => socket.destroy()); resolve({ response, socket }); });
    request.end();
  });
}
async function tls(context, connected, ca, servername = WINDOWS_MANAGED_PAC_HOST) {
  const socket = connectTls({ socket: connected.socket, servername, ca, rejectUnauthorized: true, ALPNProtocols: ['http/1.1'] });
  context.addCleanup('close owned TLS test socket', () => socket.destroy());
  await new Promise((resolve, reject) => { socket.once('secureConnect', resolve); socket.once('error', reject); });
  return socket;
}
async function get(context, socket, fixture, { marker = fixture.marker, host = WINDOWS_MANAGED_PAC_HOST } = {}) {
  const agent = new Agent({ keepAlive: false }); agent.createConnection = () => socket;
  context.addCleanup('close owned TLS test agent', () => agent.destroy());
  return new Promise((resolve, reject) => {
    const request = requestHttp({ hostname: '127.0.0.1', port: 443, method: 'GET', path: `/search?q=${marker}&adlt=off&setlang=en`, agent, headers: { Host: host, Connection: 'close' } }, response => {
      const chunks = []; response.on('data', chunk => chunks.push(chunk)); response.once('error', reject); response.once('end', () => resolve({ status: response.statusCode, body: Buffer.concat(chunks).toString('utf8') }));
    }); request.once('error', reject); request.end();
  });
}

test('valid owned PAC, numeric CONNECT and verified Bing TLS serve exactly three frozen sources', async () => {
  const context = await RunContext.create(import.meta.url, { testId: 'managed-pac-bing-closed-tunnel', tier: 'harness-unit', modelPolicy: 'Owned loopback PAC/proxy/TLS only; no system proxy changes, public web, paid model or WinHTTP claim' });
  let failure;
  try {
    const inputs = await input(context), owned = await startWindowsManagedPacFixture(inputs, context), fixture = owned.fixture;
    assert.equal(owned.stats().pacRequests, 0);
    const pac = await (await fetch(fixture.pacUrl)).text(), sandbox = createContext({}); new Script(pac).runInContext(sandbox, { timeout: 100 });
    assert.equal(sandbox.FindProxyForURL('https://www.bing.com/search?q=owned', 'www.bing.com'), `PROXY ${new URL(fixture.proxyUrl).host}`);
    assert.ok(!pac.includes('DIRECT'));
    for (const destination of ['8.8.8.8:443', '127.0.0.1:443', 'www.bing.com:443', '13.107.21.200:80']) {
      const denied = await tunnel(context, fixture, destination); assert.equal(denied.response.statusCode, 403); denied.socket.destroy();
    }
    const connected = await tunnel(context, fixture, '13.107.21.200:443'); assert.equal(connected.response.statusCode, 200);
    const secured = await tls(context, connected, inputs.caPem); assert.equal(secured.authorized, true); assert.equal(secured.alpnProtocol, 'http/1.1');
    const result = await get(context, secured, fixture); assert.equal(result.status, 200);
    const payload = windowsManagedPacPayload(fixture.fixtureId); assert.equal(result.body, payload.html);
    await context.writeArtifactJson('managed-pac-bing-received-html.json', { ...payload, html: result.body, receivedOverVerifiedOwnedTls: true });
    assert.equal((result.body.match(/class="b_algo"/g) || []).length, 3);
    for (const source of fixture.expectedSources) assert.ok(result.body.includes(source.url) && result.body.includes(source.title));
    const v6 = await tunnel(context, fixture, '[2606:4700:4700::1111]:443'); assert.equal(v6.response.statusCode, 200);
    assert.equal((await get(context, await tls(context, v6, inputs.caPem), fixture)).status, 200);
    const before = owned.stats(); assert.equal(before.originRequests, 2); assert.equal(before.connectAccepted, 2); assert.equal(before.connectDenied, 4); assert.equal(before.externalConnections, 0);
    await context.writeArtifactJson('managed-pac-fixture-observations.json', before);
    const closed = await owned.stop(); assert.equal(closed.closed, true); assert.equal(closed.activeSockets, 0); assert.equal(closed.externalConnections, 0);
    await assert.rejects(fetch(fixture.pacUrl)); assert.deepEqual(await owned.stop(), closed);
  } catch (error) { failure = error; throw error; }
  finally { await context.finish(failure ? 'failed' : 'passed', {}, failure); assert.equal(await stat(context.stateDir).then(() => true, () => false), false); }
});

test('owned TLS requires its CA and exact SNI/Host/marker; stopping one fixture preserves its peer', async () => {
  const context = await RunContext.create(import.meta.url, { testId: 'managed-pac-tls-and-peer-boundaries', tier: 'harness-unit', modelPolicy: 'Loopback TLS rejection and owner cleanup, no native Windows or public web claim' });
  let failure;
  try {
    const inputs = await input(context), owned = await startWindowsManagedPacFixture(inputs, context), peer = await startWindowsManagedPacFixture(inputs, context), f = owned.fixture;
    await assert.rejects(tls(context, await tunnel(context, f, '13.107.21.200:443'), undefined));
    await assert.rejects(tls(context, await tunnel(context, f, '13.107.21.200:443'), inputs.caPem, 'example.com'));
    for (const options of [{ host: 'example.com' }, { marker: 'OTHEROWNEDMARKER' }]) {
      const secured = await tls(context, await tunnel(context, f, '13.107.21.200:443'), inputs.caPem);
      assert.equal((await get(context, secured, f, options)).status, 403);
    }
    const held = await tunnel(context, f, '13.107.21.200:443'); assert.equal(held.response.statusCode, 200);
    const stopped = await owned.stop(); assert.equal(stopped.activeSockets, 0); assert.equal(stopped.originRequests, 0); assert.equal(stopped.originDenied, 2);
    assert.equal((await fetch(peer.fixture.pacUrl)).status, 200, 'A peer listener must survive this owner stop');
    const peerStopped = await peer.stop(); assert.equal(peerStopped.activeSockets, 0);
    await assert.rejects(startWindowsManagedPacFixture({ ...inputs, allowedConnectAddresses: ['127.0.0.1'] }, context));
    await assert.rejects(startWindowsManagedPacFixture({ ...inputs, allowedConnectAddresses: ['192.0.2.1'] }, context));
    await assert.rejects(startWindowsManagedPacFixture({ ...inputs, allowedConnectAddresses: ['www.bing.com'] }, context));
    for (const address of ['::1', 'fc00::1', '2001:db8::1', '2002::1', '3fff::1']) await assert.rejects(startWindowsManagedPacFixture({ ...inputs, allowedConnectAddresses: [address] }, context));
  } catch (error) { failure = error; throw error; }
  finally { await context.finish(failure ? 'failed' : 'passed', {}, failure); assert.equal(await stat(context.stateDir).then(() => true, () => false), false); }
});
