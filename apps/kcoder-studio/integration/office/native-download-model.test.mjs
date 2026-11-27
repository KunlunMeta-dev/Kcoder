import assert from 'node:assert/strict';
import test from 'node:test';
import { claimSpecification, discoveryCall, discoveryResult, toolResult, toolSteps } from './native-download-model.mjs';

test('download fixture has bounded literal source and independent entropy blocks', () => {
  const specification = claimSpecification('owned-test-seed');
  assert.deepEqual(specification, claimSpecification('owned-test-seed'));
  assert.equal(specification.paragraphs.length, 49);
  assert.ok(specification.paragraphs.every(item => item.text.length <= 10000));
  assert.ok(Buffer.byteLength(JSON.stringify(specification)) > 450000);
  assert.ok(Buffer.byteLength(JSON.stringify(specification)) < 1024 * 1024);
  assert.notEqual(specification.paragraphs[1].text, specification.paragraphs[2].text);
});
test('discovery parser accepts actual Markdown receipt and refuses missing metadata', () => {
  const body = { messages: [{ role: 'tool', tool_call_id: discoveryCall, content: JSON.stringify({ text: '## Tool discovery receipt\n```json\n{"tools":[{"name":"OfficeDocument"}]}\n```' }) }] };
  assert.equal(discoveryResult(body).tools[0].name, 'OfficeDocument');
  assert.throws(() => discoveryResult({ messages: [] }), /missing/);
  assert.equal(toolResult(body, 'other-call'), null);
  const steps = toolSteps('native-call', 'tool_execute', { tool_name: 'OfficeDocument', arguments: {} });
  assert.equal(JSON.parse(steps[0].delta.tool_calls[0].function.arguments).tool_name, 'OfficeDocument');
  assert.equal(steps[1].finishReason, 'tool_calls');
});
