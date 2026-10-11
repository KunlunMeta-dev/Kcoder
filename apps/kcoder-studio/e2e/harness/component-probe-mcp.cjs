const { createInterface } = require('node:readline');
const { appendFileSync } = require('node:fs');
if (!process.argv[2]) throw new Error('Owned MCP counter path is required');
createInterface({ input: process.stdin }).on('line', line => {
  const message = JSON.parse(line);
  if (message.id === undefined) return;
  let result = {};
  if (message.method === 'initialize') result = { protocolVersion: '2024-11-05', capabilities: { tools: {} }, serverInfo: { name: 'component-probe', version: '1' } };
  if (message.method === 'tools/list') result = { tools: [{ name: 'bundle_probe', description: 'Owned component probe', inputSchema: { type: 'object', properties: {} } }] };
  if (message.method === 'tools/call') {
    appendFileSync(process.argv[2], 'x', { mode: 0o600 });
    result = { content: [{ type: 'text', text: 'BUNDLE_PROBE_OK' }] };
  }
  process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: message.id, result }) + '\n');
});
