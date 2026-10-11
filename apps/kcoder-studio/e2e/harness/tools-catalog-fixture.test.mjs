import assert from 'node:assert/strict';
import test from 'node:test';
import { toolsCatalogResponseSteps } from './tools-catalog-fixture.mjs';

test('the shared catalog fixture only requests an advertised TaskList and then consumes its result', () => {
  const tools = [{ type: 'function', function: { name: 'TaskList', parameters: {} } }];
  assert.equal(toolsCatalogResponseSteps({ body: { tools, messages: [] } })[0].delta.tool_calls[0].function.name, 'TaskList');
  assert.equal(toolsCatalogResponseSteps({ body: { tools, messages: [{ role: 'tool', content: '{}' }] } })[0].delta.content, 'CATALOG_UI_DONE');
  assert.equal(toolsCatalogResponseSteps({ body: { messages: [{ role: 'user', content: 'Reply only OK.' }] } })[1].finishReason, 'stop');
});
