import { startApprovalModelFixture } from './approval-model.mjs';
import { fileURLToPath } from 'node:url';

export function toolsCatalogMcpServer() {
  return { name: 'catalog-budget', transport: 'stdio', command: process.execPath,
    args: [fileURLToPath(new URL('./tools-catalog-mcp.cjs', import.meta.url))] };
}

// A fixed tool choice verifies dispatch and presentation metadata, not model quality.
export function toolsCatalogResponseSteps({ body }) {
  return (body.tools ?? []).some(tool => (tool.function ?? tool).name === 'TaskList')
    && !body.messages?.some(message => message.role === 'tool') ? [
      { delta: { role: 'assistant', tool_calls: [{ index: 0, id: 'catalog-tool-1', type: 'function', function: { name: 'TaskList', arguments: '{}' } }] } },
      { finishReason: 'tool_calls' },
    ] : [{ delta: { content: 'CATALOG_UI_DONE' } }, { finishReason: 'stop' }];
}

export function startToolsCatalogModelFixture(context) {
  return startApprovalModelFixture(context, { responseSteps: toolsCatalogResponseSteps });
}
