import assert from 'node:assert/strict';
import test from 'node:test';
import { request as requestHttp, Agent } from 'node:http';
import { connect as connectTls } from 'node:tls';
import { readFile, stat } from 'node:fs/promises';
import { RunContext } from './run-context.mjs';
import { startWebSearchNetworkFixture } from './web-search-network-fixture.mjs';

test('owned source proxy keeps TLS verification, numeric destination allowlist and cleanup', async () => {
  const context = await RunContext.create(import.meta.url, { testId: 'owned-source-proxy-tls-and-no-external-forwarding', tier: 'harness-unit', modelPolicy: 'No model or search query; actual TLS fixture and malformed CONNECT only' });
  let failure;
  try {
    const fixture = await startWebSearchNetworkFixture(context, { scenario: 'bing-redirect' });
    const proxy = new URL(fixture.proxyUrl);
    const connect = destination => new Promise((resolve, reject) => {
      const request = requestHttp({ hostname: proxy.hostname, port: proxy.port, method: 'CONNECT', path: destination });
      request.on('connect', (response, socket) => { context.addCleanup(`close unit socket ${destination}`, () => socket.destroy()); resolve({ response, socket }); });
      request.on('error', reject); request.end();
    });
    const refused = await connect('8.8.8.8:443'); assert.equal(refused.response.statusCode, 403); refused.socket.destroy();
    const accepted = await connect('93.184.216.34:443'); assert.equal(accepted.response.statusCode, 200);
    const tls = connectTls({ socket: accepted.socket, servername: 'mcp.exa.ai', ca: await readFile(fixture.caPath), rejectUnauthorized: true, ALPNProtocols: ['http/1.1'] });
    context.addCleanup('close unit TLS socket', () => tls.destroy());
    await new Promise((resolve, reject) => { tls.once('secureConnect', resolve); tls.once('error', reject); });
    assert.equal(tls.authorized, true); assert.equal(tls.alpnProtocol, 'http/1.1');
    assert.ok(tls.getPeerCertificate().subjectaltname.includes('DNS:cn.bing.com'));
    const payload = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} });
    const agent = new Agent({ keepAlive: false }); agent.createConnection = () => tls;
    context.addCleanup('close unit HTTP agent', () => agent.destroy());
    const result = await new Promise((resolve, reject) => {
      const request = requestHttp({ hostname: '127.0.0.1', port: proxy.port, method: 'POST', path: '/mcp', agent,
        headers: { Host: 'mcp.exa.ai', 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload), Connection: 'close' } }, response => {
        const chunks = []; response.on('data', chunk => chunks.push(chunk)); response.on('end', () => resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')))); response.on('error', reject);
      }); request.on('error', reject); request.end(payload);
    });
    assert.equal(result.result.tools[0].name, 'web_search_exa'); assert.equal(fixture.sourceCalls, 0);
    const regional = await connect('13.107.21.201:443'); assert.equal(regional.response.statusCode, 200);
    const regionalTls = connectTls({ socket: regional.socket, servername: 'cn.bing.com', ca: await readFile(fixture.caPath), rejectUnauthorized: true, ALPNProtocols: ['http/1.1'] });
    context.addCleanup('close regional unit TLS socket', () => regionalTls.destroy());
    await new Promise((resolve, reject) => { regionalTls.once('secureConnect', resolve); regionalTls.once('error', reject); });
    assert.equal(regionalTls.authorized, true); regionalTls.destroy();
    assert.deepEqual(fixture.observations.methods, ['tools/list']); assert.deepEqual(fixture.observations.failures, []);
  } catch (error) { failure = error; throw error; }
  finally { await context.finish(failure ? 'failed' : 'passed', { noBusinessQueries: true }, failure); assert.equal(await stat(context.stateDir).then(() => true, () => false), false); }
});
