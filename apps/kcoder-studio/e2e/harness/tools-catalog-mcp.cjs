const { createInterface } = require('node:readline');

// A deterministic, read-only catalog larger than the presentation budget.
const tools = Array.from({ length: 520 }, (_, index) => ({
  name: `catalog_${String(index).padStart(3, '0')}`,
  description: 'Catalog presentation fixture',
  inputSchema: { type: 'object', properties: {}, additionalProperties: false },
}));
createInterface({ input: process.stdin }).on('line', line => {
  const message = JSON.parse(line);
  if (message.id === undefined) return;
  let result;
  if (message.method === 'initialize') {
    result = { protocolVersion: '2024-11-05', capabilities: { tools: {} },
      serverInfo: { name: 'catalog-budget-fixture', version: '1' } };
  } else if (message.method === 'tools/list') {
    result = { tools };
  } else if (message.method === 'tools/call') {
    result = { content: [{ type: 'text', text: 'CATALOG_FIXTURE_RESULT' }] };
  } else {
    result = {};
  }
  process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id: message.id, result })}\n`);
});
