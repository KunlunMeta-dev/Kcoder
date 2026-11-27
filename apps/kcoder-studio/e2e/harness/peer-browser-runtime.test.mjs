import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { createServer } from 'node:http';
import { RunContext } from './run-context.mjs';
import { acceptWebSocket, createWebSocketFrameCodec } from '../../src/websocket-frame-codec.js';
import { openOwnedPeerBrowserRuntime } from './peer-browser-runtime.mjs';

// Actual loopback HTTP and WebSocket protocol/lifecycle only. This endpoint is
// a bounded test server, not evidence of Native execution or product authority.
for (const supportsPeer of [true, false]) test(`owned browser runtime authenticates over HTTP and closes after peer capability ${supportsPeer}`, async () => {
  const context = await RunContext.create(import.meta.url, { testId: `owned-browser-rpc-${supportsPeer}`,
    tier: 'model-independent', modelPolicy: 'Loopback harness HTTP/WS protocol and cleanup only; synthetic test server, no Native/model authority claim.' });
  let failure;
  try {
    const authToken = randomBytes(24).toString('base64url'), session = randomBytes(24).toString('base64url');
    context.registerSecret(authToken); context.registerSecret(session);
    const cookie = `kcoder_studio_session=${session}`, sockets = new Set(), calls = [];
    context.registerSecret(cookie);
    const server = createServer(async (request, response) => {
      if (request.url === '/login' && request.method === 'POST') {
        let body = ''; for await (const chunk of request) body += chunk;
        assert.equal(new URLSearchParams(body).get('token'), authToken);
        response.writeHead(303, { 'set-cookie': cookie + '; HttpOnly; Path=/', location: '/' }).end();
      } else if (request.url === '/api/mobile/pairing') {
        assert.equal(request.headers.cookie, cookie);
        response.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({
          token: 'must-never-be-returned-pairing-secret', routeProof: 'must-never-be-returned-route-proof',
          devices: [{ id: 'owned-device-00000001', label: 'private-device-label', lastUsedAt: 100, expiresAt: 200 }],
        }));
      } else {
        assert.equal(request.headers.cookie, cookie);
        response.writeHead(200, { 'content-type': 'text/html' }).end('<meta name="kcoder-rpc-token" content="cookie-auth">');
      }
    });
    server.on('connection', socket => { sockets.add(socket); socket.on('close', () => sockets.delete(socket)); });
    server.on('upgrade', (request, socket) => {
      assert.equal(request.headers.cookie, cookie);
      const address = new URL(request.url, 'http://127.0.0.1');
      assert.equal(address.searchParams.get('server'), 'owned-native');
      assert.equal(address.searchParams.get('workspace'), '/owned-workspace');
      assert.equal(request.headers.authorization, undefined);
      assert.equal(acceptWebSocket(request, socket), true);
      const { frame, decodeFrames } = createWebSocketFrameCodec({ maxMessageBytes: 65536 });
      let buffer = Buffer.alloc(0); const fragments = [];
      socket.on('data', chunk => {
        buffer = Buffer.concat([buffer, chunk]);
        const decoded = decodeFrames(buffer, fragments); buffer = decoded.rest;
        if (decoded.controls.some(control => control.opcode === 8)) { socket.end(frame(Buffer.alloc(0), 8)); return; }
        for (const raw of decoded.messages) {
          const input = JSON.parse(raw); calls.push(input.method);
          const result = input.method === 'initialize' ? { cwd: '/owned-workspace', capabilities: { experimental: {
            crossSessionDiscoveryV1: true, crossSessionMessagesV1: supportsPeer, peerAgentMessagesV1: true } } } : { original: true };
          socket.write(frame(JSON.stringify({ jsonrpc: '2.0', id: input.id, result })));
        }
      });
    });
    context.addCleanup('close owned browser RPC protocol server', async () => {
      for (const socket of sockets) socket.destroy();
      await new Promise(resolve => server.close(resolve));
    });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    context.registerPort('owned-browser-rpc-protocol', server.address().port);
    const baseUrl = `http://127.0.0.1:${server.address().port}`;
    const open = () => openOwnedPeerBrowserRuntime(context, { baseUrl, wsUrl: baseUrl.replace('http:', 'ws:'), authToken },
      { serverId: 'owned-native', workspace: '/owned-workspace' });
    if (supportsPeer) {
      const runtime = await open();
      assert.equal(runtime.independentDeviceFamily, true);
      assert.equal(runtime.authentication, 'actual-http-browser-cookie');
      assert.deepEqual(await runtime.request('thread/read', { threadId: 'existing-only' }), { original: true });
      assert.deepEqual(await runtime.devices(), [{ id: 'owned-device-00000001', lastUsedAt: 100, expiresAt: 200 }]);
      await runtime.close(); await runtime.close();
      assert.equal(runtime.socket.readyState, 3);
      assert.deepEqual(calls, ['initialize', 'thread/read']);
    } else await assert.rejects(open(), /crossSessionMessagesV1/);
  } catch (error) { failure = error; throw error; }
  finally { await context.finish(failure ? 'failed' : 'passed', { actualLoopbackTransport: true, nativeExecution: false }, failure); }
});
