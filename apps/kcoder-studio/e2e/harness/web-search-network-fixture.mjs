import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import { createServer as createTlsServer } from 'node:tls';
import { chmod, mkdir, readFile } from 'node:fs/promises';
import { createWebSourceGates } from './web-search-source-gates.mjs';
import { waitFor, requireExecutable } from './run-context.mjs';

export const WEB_FIXTURE_BUILD_TAG = 'kcoder-web-network-test-fixture/1';
export const WEB_FIXTURE_HOSTS = Object.freeze({ 'mcp.exa.ai': ['93.184.216.34'], 'example.com': ['93.184.215.14'] });

// Fixed model choices and origin payloads prove protocol/ownership/rendering, not model or public-search quality.
export async function startWebSearchNetworkFixture(context, { resultCount = 12, scenario = 'positive' } = {}) {
  assert.ok(Number.isInteger(resultCount) && resultCount > 0 && resultCount <= 20);
  assert.ok(['positive', 'fallback', 'fallback-fetch-denied', 'unavailable', 'empty', 'bing-redirect', 'timing', 'cancel-tls', 'cancel-stream', 'cancel-queue', 'revoke-handshake', 'cancel-fetch-stream'].includes(scenario));
  const timing = scenario === 'timing';
  const controlled = timing || scenario.startsWith('cancel-') || scenario === 'revoke-handshake';
  const gates = createWebSourceGates();
  const hosts = scenario === 'bing-redirect'
    ? { ...WEB_FIXTURE_HOSTS, 'www.bing.com': ['13.107.21.200'], 'cn.bing.com': ['13.107.21.201'] }
    : scenario === 'fallback' || scenario === 'fallback-fetch-denied' || scenario === 'unavailable' ? { ...WEB_FIXTURE_HOSTS, 'www.bing.com': ['13.107.21.200'] } : WEB_FIXTURE_HOSTS;
  const fixtureId = randomUUID();
  const pageUrl = `https://example.com/kcoder-owned-${fixtureId}/page-1`;
  const marker = `OWNEDWEBBODY${fixtureId.replaceAll('-', '')}`;
  const profile = context.pathInState(`web-network/${fixtureId}`);
  await mkdir(profile, { recursive: true, mode: 0o700 });
  const fixturePath = await context.writeStateJson(`web-network/${fixtureId}/dns-fixture.json`, { schemaVersion: 1, fixtureId, hosts });
  const openssl = await requireExecutable(process.env.KCODER_E2E_OPENSSL_BIN || '/usr/bin/openssl', 'OpenSSL for owned TLS source fixture');
  const ca = context.pathInState(`web-network/${fixtureId}/ca.pem`), caKey = context.pathInState(`web-network/${fixtureId}/ca-key.pem`);
  const key = context.pathInState(`web-network/${fixtureId}/leaf-key.pem`), csr = context.pathInState(`web-network/${fixtureId}/leaf.csr`), cert = context.pathInState(`web-network/${fixtureId}/leaf.pem`);
  const command = async (label, args) => {
    const child = context.spawnOwned(`${label}-${fixtureId}`, openssl, args);
    await waitFor(() => child.exitCode !== null ? { code: child.exitCode } : null, 15_000, label, 30, context.abortSignal);
    assert.equal(child.exitCode, 0, `${label} must create valid fixture certificates`);
  };
  await command('search-fixture-ca', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '1', '-subj', '/CN=KCoder owned network fixture CA', '-addext', 'basicConstraints=critical,CA:TRUE', '-addext', 'keyUsage=critical,keyCertSign,cRLSign', '-keyout', caKey, '-out', ca]);
  await command('search-fixture-leaf', ['req', '-new', '-newkey', 'rsa:2048', '-nodes', '-subj', '/CN=mcp.exa.ai', '-addext', `subjectAltName=${Object.keys(hosts).map(host => `DNS:${host}`).join(',')}`, '-addext', 'basicConstraints=critical,CA:FALSE', '-addext', 'extendedKeyUsage=serverAuth', '-keyout', key, '-out', csr]);
  for (const path of [caKey, key]) { await chmod(path, 0o600); for (const line of (await readFile(path, 'utf8')).split(/\r?\n/)) if (line && !line.startsWith('-----')) context.registerSecret(line); }
  // Every fixture has a new CA and one leaf. An explicit serial avoids
  // OpenSSL's default serial-file path limit in long owned worktree paths.
  await command('search-fixture-sign', ['x509', '-req', '-in', csr, '-CA', ca, '-CAkey', caKey, '-set_serial', '1', '-days', '1', '-copy_extensions', 'copy', '-out', cert]);
  const observations = { connects: [], tls: [], methods: [], searches: [], pages: [], model: [], failures: [], closedSessions: 0, queries: [], gates: gates.observations };
  const sockets = new Set(), peers = new Map(), active = new Set();
  const sessions = new Set();
  let sourceCalls = 0, mainModelCalls = 0, sourceConnections = 0;
  const track = socket => { sockets.add(socket); socket.on('error', () => {}); socket.once('close', () => sockets.delete(socket)); return socket; };
  const body = async request => {
    const chunks = []; let bytes = 0;
    for await (const chunk of request) { bytes += chunk.length; if (bytes > 2 * 1024 * 1024) throw new Error('Fixture request budget exceeded'); chunks.push(chunk); }
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  };
  const text = message => typeof message?.content === 'string' ? message.content : (message?.content || []).filter(part => part.type === 'text').map(part => part.text).join('\n');
  const reply = (response, content, name, input, sequence) => {
    const delta = name ? { tool_calls: [{ index: 0, id: `owned-web-${name}-${sequence}`, type: 'function', function: { name, arguments: JSON.stringify(input) } }] } : { content };
    response.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store' });
    response.write(`data: ${JSON.stringify({ id: `owned-web-model-${sequence}`, object: 'chat.completion.chunk', choices: [{ index: 0, delta, finish_reason: null }] })}\n\n`);
    response.write(`data: ${JSON.stringify({ id: `owned-web-model-${sequence}`, object: 'chat.completion.chunk', choices: [{ index: 0, delta: {}, finish_reason: name ? 'tool_calls' : 'stop' }], usage: { prompt_tokens: 100, completion_tokens: 30, total_tokens: 130 } })}\n\n`);
    response.end('data: [DONE]\n\n');
  };
  const model = async (request, response) => {
    if (request.method === 'HEAD') { response.writeHead(200); response.end(); return; }
    if (request.method === 'GET' && request.url === '/v1/models') { response.writeHead(200, { 'content-type': 'application/json' }); response.end(JSON.stringify({ object: 'list', data: [{ id: 'owned-search-model', object: 'model' }] })); return; }
    assert.equal(request.method, 'POST'); assert.equal(request.url, '/v1/chat/completions');
    const input = await body(request), messages = input.messages || [], names = (input.tools || []).map(tool => tool.function?.name || tool.name);
    if (request.headers.authorization) context.registerSecret(request.headers.authorization);
    assert.equal(request.headers.authorization, undefined, 'The owned model fixture needs no credentials');
    if (!names.includes('WebSearch')) { observations.model.push({ kind: 'auxiliary', toolNames: names }); assert.ok(observations.model.length <= (controlled ? 32 : 6)); reply(response, '受控搜索链验收', null, null, observations.model.length); return; }
    assert.ok(names.includes('WebFetch'), 'Default normal session must expose actual WebFetch');
    assert.ok(++mainModelCalls <= (timing ? 30 : controlled ? 16 : scenario === 'positive' || scenario === 'fallback-fetch-denied' ? 3 : 2), 'Only search, fetch and final-response protocol stages are permitted');
    const lastOwnedInput = controlled ? messages.findLastIndex(message => message.role === 'user' && /WEBCASE[A-Z0-9]+/.test(text(message))) : -1;
    const results = messages.slice(lastOwnedInput + 1).filter(message => message.role === 'tool');
    assert.ok(messages.every(message => !text(message).includes('"webSources"')) && !JSON.stringify(messages).includes('"webSources"'), 'Native metadata must stay outside the model transcript');
    const caseKey = controlled ? text(messages[lastOwnedInput]).match(/WEBCASE[A-Z0-9]+/)?.[0] : undefined;
    if (controlled) assert.ok(caseKey, 'Controlled lifecycle turns require their own public fixture marker');
    observations.model.push({ kind: 'ordinary-turn', caseKey, toolNames: names, completedToolResults: results.length });
    if (scenario === 'cancel-fetch-stream' && caseKey === 'WEBCASEFETCHRECOVERY') {
      if (results.length === 0) reply(response, null, 'WebFetch', { url: pageUrl, prompt: '读取夹具原文及正文标记。' }, mainModelCalls);
      else { assert.ok(text(results[0]).includes(marker)); reply(response, `原文重新读取完成 ${caseKey}`, null, null, mainModelCalls); }
      return;
    }
    if (controlled && results.length > 0) {
      assert.ok(text(results[0]).includes('Search status:'));
      if (timing) {
        assert.ok(text(results[0]).includes('Search provider: exa-public'));
        if (results.length === 1) {
          reply(response, null, 'WebFetch', { url: pageUrl, prompt: 'Read the owned timing document.', fresh: true }, mainModelCalls); return;
        }
        assert.equal(results.length, 2); assert.ok(text(results[1]).includes(marker));
      }
      if (scenario === 'cancel-fetch-stream' && caseKey === 'WEBCASEOWNER' && results.length === 1) {
        assert.ok(text(results[0]).includes(pageUrl)); reply(response, null, 'WebFetch', { url: pageUrl, prompt: '读取夹具原文及正文标记。' }, mainModelCalls); return;
      }
      reply(response, `受控原生回合完成 ${caseKey}`, null, null, mainModelCalls); return;
    }
    if (results.length === 0) { reply(response, null, 'WebSearch', { query: `受控示例发布页 原始公告${caseKey ? ` ${caseKey}` : ''}`, num_results: resultCount }, mainModelCalls); return; }
    const search = text(results[0]);
    if (scenario === 'fallback-fetch-denied') {
      assert.ok(search.includes('Search provider: bing-html'));
      if (results.length === 1) { reply(response, null, 'WebFetch', { url: pageUrl, prompt: 'Read the owned source page.' }, mainModelCalls); return; }
      assert.equal(results.length, 2); assert.match(text(results[1]), /403|forbidden|denied/i);
      reply(response, `搜索已返回来源；原文请求被源站拒绝（403），没有读取正文。${marker}`, null, null, mainModelCalls); return;
    }
    if (scenario !== 'positive') {
      const expected = scenario === 'fallback' || scenario === 'bing-redirect' ? 'Search provider: bing-html' : `Search status: ${scenario === 'empty' ? 'empty' : 'failed'}`;
      assert.ok(search.includes(expected), `Actual native search must report ${expected}`);
      reply(response, `受控协议验收完成：${scenario}。`, null, null, mainModelCalls); return;
    }
    assert.ok(search.includes('Search provider: exa-public')); assert.ok(search.includes(pageUrl));
    if (results.length === 1) { reply(response, null, 'WebFetch', { url: pageUrl, prompt: '读取原文并返回示例正文标记和标题。' }, mainModelCalls); return; }
    assert.ok(text(results[1]).includes(marker), 'Actual WebFetch must deliver the owned HTML body before answering');
    reply(response, `已完成示例发布页的搜索和原文读取。正文标记：${marker}\n\n[查看受控示例原文](${pageUrl})`, null, null, mainModelCalls);
  };
  const origin = createServer((request, response) => run(async () => {
    const host = request.socket.fixtureHost;
    if (request.headers.authorization) context.registerSecret(request.headers.authorization);
    assert.equal(request.headers.authorization, undefined, 'Built-in search and direct page reads require no search credentials');
    assert.ok(Object.keys(hosts).includes(host));
    assert.ok([host, `${host}:443`].includes(request.headers.host), 'TLS origin and HTTP Host must agree');
    if (host === 'example.com') {
      assert.equal(request.method, 'GET'); assert.equal(request.url, new URL(pageUrl).pathname);
      observations.pages.push({ host, path: request.url });
      if (scenario === 'fallback-fetch-denied') { response.writeHead(403, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' }); response.end('<html><title>Owned access denied</title><body>403: this owned source requires permission.</body></html>'); return; }
      response.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
      const html = `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><title>受控示例原文</title></head><body><main><h1>受控示例公告</h1><p>此页面只用于确定性协议与界面验收。</p><p>${marker}</p></main></body></html>`;
      if (scenario === 'cancel-fetch-stream' && observations.pages.length === 1) {
        const split = html.indexOf(marker); response.write(html.slice(0, split));
        await gates.pause('owner-page-stream', response); response.end(html.slice(split)); return;
      }
      response.end(html); return;
    }
    if (host === 'www.bing.com' || host === 'cn.bing.com') {
      const query = new URL(request.url, `https://${host}`);
      assert.equal(request.method, 'GET'); assert.equal(query.pathname, '/search');
      assert.equal(query.searchParams.get('q'), '受控示例发布页 原始公告');
      observations.searches.push({ host, path: query.pathname, scenario, query: query.searchParams.get('q'), market: query.searchParams.get('setmkt') });
      if (scenario === 'unavailable') { response.writeHead(503); response.end('Owned temporary outage'); return; }
      if (scenario === 'bing-redirect' && host === 'www.bing.com') {
        const target = new URL(query); target.hostname = 'cn.bing.com';
        response.writeHead(302, { location: target.href }); response.end(); return;
      }
      response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      response.end(`<ol id="b_results"><li class="b_algo"><h2><a href="${pageUrl}">受控备用示例发布页</a></h2><p class="b_lineclamp">受控备用来源摘要</p></li></ol>`); return;
    }
    const url = new URL(request.url, 'https://mcp.exa.ai'); assert.equal(url.pathname, '/mcp'); assert.equal(url.search, '');
    if (request.method === 'DELETE') { assert.ok(sessions.delete(request.headers['mcp-session-id'])); observations.closedSessions++; response.writeHead(204); response.end(); return; }
    assert.equal(request.method, 'POST'); const rpc = await body(request); observations.methods.push(rpc.method);
    assert.ok(observations.methods.length <= (controlled ? 64 : 6), 'MCP fixture handshake/query budget must remain bounded');
    let result;
    if (rpc.method === 'initialize') { const session = randomUUID(); context.registerSecret(session); sessions.add(session);
      if (scenario === 'revoke-handshake' && observations.methods.filter(method => method === 'initialize').length === 1) await gates.pause('owner-handshake', response);
      response.setHeader('Mcp-Session-Id', session); result = { protocolVersion: '2025-03-26', capabilities: { tools: {} }, serverInfo: { name: 'owned-search-network-fixture', version: '1' } }; }
    else if (rpc.method === 'notifications/initialized') { response.writeHead(202); response.end(); return; }
    else if (rpc.method === 'tools/list') result = { tools: [{ name: 'web_search_exa', description: 'Owned deterministic source response', inputSchema: { type: 'object', properties: { query: { type: 'string' }, numResults: { type: 'integer', minimum: 1, maximum: 20 } }, required: ['query'] } }] };
    else if (rpc.method === 'tools/call') {
      assert.equal(rpc.params.name, 'web_search_exa'); assert.ok(++sourceCalls <= (timing ? 10 : controlled ? 8 : 1)); assert.equal(rpc.params.arguments.numResults, resultCount);
      assert.ok(sessions.has(request.headers['mcp-session-id']));
      observations.queries.push(rpc.params.arguments.query);
      if (controlled && rpc.params.arguments.query.includes('WEBCASEPEER')) await gates.pause('peer-query', response);
      if (scenario === 'cancel-queue') { const key = rpc.params.arguments.query.match(/WEBCASEACTIVE[1-4]/)?.[0]; assert.ok(key, 'A queued cancelled request must never reach the source'); await gates.pause(key, response); }
      if (scenario === 'fallback' || scenario === 'fallback-fetch-denied' || scenario === 'unavailable' || scenario === 'bing-redirect') { response.writeHead(503); response.end('Owned temporary outage'); return; }
      if (scenario === 'empty') {
        response.writeHead(200, { 'content-type': 'application/json' });
        response.end(JSON.stringify({ jsonrpc: '2.0', id: rpc.id, result: { structuredContent: { results: [] } } })); return;
      }
      const records = Array.from({ length: resultCount }, (_, index) => `Title: 受控示例发布页 ${index + 1}\nURL: https://example.com/kcoder-owned-${fixtureId}/page-${index + 1}\nPublished: 2026-10-30\nAuthor: 夹具作者\nHighlights:\n示例搜索摘要 ${index + 1}`);
      result = { content: [{ type: 'text', text: records.join('\n\n---\n\n') }] };
    } else throw new Error('Unexpected source protocol method');
    const envelope = JSON.stringify({ jsonrpc: '2.0', id: rpc.id, result });
    if (scenario === 'cancel-stream' && rpc.method === 'tools/call' && rpc.params.arguments.query.includes('WEBCASEOWNER')) {
      response.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store' });
      response.write(`data: ${envelope.slice(0, 40)}`);
      await gates.pause('owner-stream', response); response.end(`${envelope.slice(40)}\n\n`); return;
    }
    response.writeHead(200, { 'content-type': 'application/json' }); response.end(envelope);
  }, response));
  const tls = createTlsServer({ key: await readFile(key), cert: await readFile(cert), ALPNProtocols: ['http/1.1'] }, socket => {
    track(socket); const expected = peers.get(`${socket.remoteAddress}:${socket.remotePort}`)?.host;
    if (!expected || socket.servername !== expected) { observations.failures.push('TLS SNI does not match owned CONNECT destination'); socket.destroy(); return; }
    observations.tls.push({ host: socket.servername, alpn: socket.alpnProtocol || null }); socket.fixtureHost = expected; origin.emit('connection', socket);
  });
  tls.on('tlsClientError', error => observations.failures.push(`TLS client error: ${error.code || 'unknown'}`));
  const proxy = createServer((request, response) => run(() => model(request, response), response));
  proxy.on('connection', track);
  proxy.on('connect', (request, socket, head) => {
    const host = Object.entries(hosts).find(([, ips]) => ips.some(ip => request.url === `${ip}:443`))?.[0];
    observations.connects.push({ destination: request.url, accepted: Boolean(host) });
    if (!host || head.length) { socket.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n'); return; }
    const peer = `${socket.remoteAddress}:${socket.remotePort}`; peers.set(peer, { socket, host });
    socket.once('close', () => { if (peers.get(peer)?.socket === socket) peers.delete(peer); });
    socket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
    const ordinal = host === 'mcp.exa.ai' ? ++sourceConnections : 0;
    run(async () => {
      if (scenario === 'cancel-tls' && ordinal === 1) {
        socket.allowHalfOpen = false;
        // Consume the bounded ClientHello so a paused readable cannot conceal the peer's FIN.
        const chunks = []; let bytes = 0;
        const consume = chunk => { bytes += chunk.length; observations.clientHelloBytes = bytes; if (bytes > 65536) { observations.failures.push('Owned TLS ClientHello exceeded its bounded gate'); socket.destroy(); return; } chunks.push(chunk); };
        const paused = gates.pause('owner-tls', socket); socket.on('data', consume); socket.resume();
        await paused; socket.pause(); socket.removeListener('data', consume);
        observations.clientHelloBytes = bytes;
        if (!socket.destroyed && chunks.length) socket.unshift(Buffer.concat(chunks));
      }
      if (!socket.destroyed) tls.emit('connection', socket);
    }, null);
  });
  function run(work, response) {
    const task = Promise.resolve().then(work).catch(error => { observations.failures.push(String(error.message).slice(0, 256)); if (response) { if (!response.headersSent) response.writeHead(500, { 'content-type': 'application/json' }); response.end(JSON.stringify({ error: { message: 'Owned source fixture rejected a protocol request' } })); } });
    active.add(task); void task.finally(() => active.delete(task));
  }
  context.addCleanup('close owned source proxy/model/TLS origins', async () => {
    gates.releaseAll(); const closed = new Promise(resolve => proxy.close(resolve)); for (const socket of sockets) socket.destroy(); proxy.closeAllConnections(); await closed; await Promise.allSettled([...active]); peers.clear();
  });
  await new Promise(resolve => proxy.listen(0, '127.0.0.1', resolve)); const port = proxy.address().port; context.registerPort(`owned-web-network-proxy-${fixtureId}`, port);
  return { fixtureId, pageUrl, marker, fixturePath, gates, caPath: ca, proxyUrl: `http://127.0.0.1:${port}`, modelUrl: `http://127.0.0.1:${port}/v1`, observations,
    get sourceCalls() { return sourceCalls; }, get mainModelCalls() { return mainModelCalls; } };
}
