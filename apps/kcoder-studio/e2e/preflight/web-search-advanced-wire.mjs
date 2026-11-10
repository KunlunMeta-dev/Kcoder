import assert from 'node:assert/strict';
import { runE2E } from '../harness/run-context.mjs';

assert.equal(process.env.KCODER_E2E_WEB_EXTERNAL_NETWORK, '1');
await runE2E(import.meta.url, {
  testId: 'anonymous-advanced-empty-wire-observation', tier: 'external-provider', retainSuccessLogs: true,
  modelPolicy: 'One fixed public query for upstream wire-format diagnosis only; not native policy, source quality, model or package acceptance.',
}, async context => {
  const endpoint = 'https://mcp.exa.ai/mcp?tools=web_search_advanced_exa';
  let session;
  async function rpc(method, params, id) {
    const headers = { 'content-type': 'application/json', accept: 'application/json, text/event-stream', 'MCP-Protocol-Version': '2025-03-26' };
    if (session) headers['Mcp-Session-Id'] = session;
    const response = await fetch(endpoint, { method: 'POST', headers, body: JSON.stringify({ jsonrpc: '2.0', method, params, ...(id ? { id } : {}) }), redirect: 'error', signal: AbortSignal.timeout(20000) });
    const incoming = response.headers.get('Mcp-Session-Id');
    if (incoming) { session = incoming; context.registerSecret(incoming); }
    assert.ok(response.ok);
    let text = '';
    const decoder = new TextDecoder('utf-8', { fatal: true });
    for await (const bytes of response.body ?? []) { text += decoder.decode(bytes, { stream: true }); assert.ok(Buffer.byteLength(text) <= 512 * 1024); }
    text += decoder.decode();
    if (!id) return null;
    const frames = response.headers.get('content-type')?.includes('text/event-stream')
      ? text.split('\n').filter(line => line.startsWith('data:')).map(line => JSON.parse(line.slice(5).trim()))
      : [JSON.parse(text)];
    const frame = frames.find(value => value.id === id);
    assert.ok(frame); return frame;
  }
  try {
    await rpc('initialize', { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'owned-public-wire-observer', version: '1' } }, 1);
    await rpc('notifications/initialized', {}, null);
    const now = new Date(), since = new Date(now.getTime() - 86400000), until = new Date(now.getTime() + 86400000);
    const args = { query: 'Python software release announcement', numResults: 3, type: 'auto', userLocation: 'US', includeDomains: ['python.org'], contextMaxCharacters: 10000,
      startPublishedDate: since.toISOString().slice(0,10), endPublishedDate: until.toISOString().slice(0,10), enableSummary: false, enableHighlights: true, highlightsMaxCharacters: 2000 };
    const frame = await rpc('tools/call', { name: 'web_search_advanced_exa', arguments: args }, 2);
    await context.writeArtifactJson('upstream-public-result.json', { scope: 'Protocol diagnosis only', logicalQueries: 1, modelCalls: 0, input: args, frame });
    return { observed: true, logicalQueries: 1, modelCalls: 0, isError: frame.result?.isError ?? null };
  } finally {
    if (session) await fetch(endpoint, { method: 'DELETE', headers: { 'Mcp-Session-Id': session, 'MCP-Protocol-Version': '2025-03-26' }, redirect: 'error', signal: AbortSignal.timeout(2000) }).catch(() => {});
  }
});
