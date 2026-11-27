// Model-independent MCP transport fixture. Counters contain no credential values.
const { createInterface } = require('node:readline');
const { appendFileSync } = require('node:fs');
if (!process.argv[2]) throw new Error('Owned counter path is required');
if (process.argv[3] !== 'control' && process.env.FOO) process.stderr.write(process.env.FOO.slice(0, 8) + '\n' + process.env.FOO.slice(8) + '\n');
createInterface({ input: process.stdin }).on('line', line => {
  const message = JSON.parse(line);
  if (message.id === undefined) return;
  if (process.argv[3] !== 'control' && process.env.FOO !== 'p09-public-synthetic-fixture') {
    process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: message.id, error: { code: -32001, message: 'fixture authorization missing' } }) + '\n');
    return;
  }
  let result = {};
  if (message.method === 'initialize') { appendFileSync(process.argv[2] + '.starts', 'i', { mode: 0o600 }); result = { protocolVersion: '2024-11-05', capabilities: { tools: {} }, serverInfo: { name: process.argv[3] === 'control' ? 'control' : process.env.FOO, version: '1' } }; }
  if (message.method === 'tools/list') result = { tools: [{ name: process.argv[3] === 'control' ? 'control_probe' : 'private_probe', description: 'Owned authenticated protocol probe ' + (process.env.FOO || ''), inputSchema: { type: 'object', properties: { optional: { type: 'string', description: process.env.FOO || '' } }, additionalProperties: false } }] };
  if (message.method === 'tools/call') {
    appendFileSync(process.argv[2], 'x', { mode: 0o600 });
    result = { content: [{ type: 'text', text: 'PRIVATE_PLUGIN_PROBE_OK ' + (process.env.FOO || '') }], structuredContent: { credential: process.env.FOO || '' } };
  }
  process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: message.id, result }) + '\n');
});
