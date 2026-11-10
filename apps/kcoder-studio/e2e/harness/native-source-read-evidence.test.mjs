import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { nativeSourceReadEvidence, nativeSourceReadRange, nativeSourceRequestShape, nativeTextOutputShape } from './native-source-read-evidence.mjs';

const examples = JSON.parse(readFileSync(new URL('../../shared/generated/examples.integrations-knowledge.json', import.meta.url), 'utf8'));
const sha = value => createHash('sha256').update(value).digest('hex');
function source() {
  const publication = structuredClone(examples.KnowledgePublication[0].decoded);
  publication.pages[0].markdown = 'PRIVATE_SOURCE_CANARY';
  const text = JSON.stringify({ schemaVersion: 1, kind: 'publication', publication });
  return { index: 0, sha256: sha(text), totalBytes: Buffer.byteLength(text), offset: 0,
    nextOffset: Buffer.byteLength(text), complete: true, text };
}
for (const protocol of ['openai', 'anthropic', 'responses']) test(`source evidence observes ${protocol} actual tool-result roles without retaining source text`, () => {
  const value = source(), id = 'actual-call';
  const body = protocol === 'openai' ? { messages: [
    { role: 'assistant', tool_calls: [{ id, function: { name: 'AutomationSourceRead' } }] },
    { role: 'tool', tool_call_id: id, content: JSON.stringify(value) },
  ] } : protocol === 'anthropic' ? { messages: [
    { role: 'assistant', content: [{ type: 'tool_use', id, name: 'AutomationSourceRead' }] },
    { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content: [{ type: 'text', text: JSON.stringify(value) }] }] },
  ] } : { input: [{ type: 'function_call', call_id: id, name: 'AutomationSourceRead' },
    { type: 'function_call_output', call_id: id, output: JSON.stringify(value) }] };
  const proofs = nativeSourceReadEvidence(body);
  assert.equal(proofs.length, 1); assert.equal(proofs[0].sha256, value.sha256);
  assert.equal(proofs[0].pageHashes[0].markdownSha256, sha('PRIVATE_SOURCE_CANARY'));
  assert.ok(!JSON.stringify(proofs).includes('PRIVATE_SOURCE_CANARY'));
  assert.ok(!JSON.stringify(proofs).includes('actual-call'));
});
test('user text, unmatched calls, partial chunks and corrupt identities never become source proof', () => {
  const value = source();
  const body = result => ({ messages: [{ role: 'assistant', tool_calls: [{ id: 'call', function: { name: 'AutomationSourceRead' } }] },
    { role: 'tool', tool_call_id: 'call', content: JSON.stringify(result) }] });
  assert.deepEqual(nativeSourceReadEvidence({ messages: [{ role: 'user', content: JSON.stringify(value) }] }), []);
  assert.deepEqual(nativeSourceReadEvidence({ messages: [{ role: 'tool', tool_call_id: 'call', content: JSON.stringify(value) }] }), []);
  for (const invalid of [{ ...value, complete: false }, { ...value, offset: 1 }, { ...value, sha256: '0'.repeat(64) },
    { ...value, grant: true }, { ...value, nextOffset: value.nextOffset - 1 }]) assert.deepEqual(nativeSourceReadEvidence(body(invalid)), []);
  const failed = { messages: [{ role: 'assistant', content: [{ type: 'tool_use', id: 'call', name: 'AutomationSourceRead' }] },
    { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'call', content: JSON.stringify(value), is_error: true }] }] };
  assert.deepEqual(nativeSourceReadEvidence(failed), []);
});
test('terminal null cursor preserves full-byte source proof and cannot bless truncated content', () => {
  const value = { ...source(), nextOffset: null };
  const body = result => ({ messages: [
    { role: 'assistant', tool_calls: [{ id: 'actual-null-eof', function: { name: 'AutomationSourceRead' } }] },
    { role: 'tool', tool_call_id: 'actual-null-eof', content: JSON.stringify(result) },
  ] });
  assert.equal(nativeSourceReadEvidence(body(value)).length, 1);
  for (const invalid of [{ ...value, text: value.text.slice(0, -1) }, { ...value, complete: false },
    { ...value, offset: 1 }, { ...value, sha256: '0'.repeat(64) }])
    assert.deepEqual(nativeSourceReadEvidence(body(invalid)), []);
});
test('diagnostic read ranges and request shape retain no arbitrary model arguments', () => {
  assert.deepEqual(nativeSourceReadRange('AutomationSourceRead', '{"index":0,"offset":1547,"limit":8192}'),
    { index: 0, offset: 1547, limit: 8192, extraFieldCount: 0 });
  assert.deepEqual(nativeSourceReadRange('AutomationSourceRead', '{"index":0,"secret":"PRIVATE_CANARY"}'),
    { index: 0, offset: 0, limit: 8192, extraFieldCount: 1 });
  assert.equal(nativeSourceReadRange('Other', '{"secret":"PRIVATE_CANARY"}'), undefined);
  assert.deepEqual(nativeSourceRequestShape({ tool_choice: { type: 'tool', name: 'AutomationSourceRead' }, private: 'PRIVATE_CANARY' }),
    { toolChoiceMode: 'tool', toolChoiceSourceReader: true, nativeSchemaConfigured: false });
});
test('visible response shape counts actual protocol text fragments without retaining content', () => {
  const fragments = ['  {', '"fact":"PRIVATE_OUTPUT_CANARY"', ',"note":"已核对"}'];
  const frames = [
    { type: 'content_block_start', content_block: { type: 'text', text: fragments[0] } },
    { choices: [{ delta: { content: fragments[1] } }] },
    { type: 'response.output_text.delta', delta: fragments[2] },
  ];
  let shape = nativeTextOutputShape(null, null);
  for (const frame of frames) shape = nativeTextOutputShape(shape, frame);
  assert.deepEqual(shape, { fragmentBytes: fragments.reduce((bytes, value) => bytes + Buffer.byteLength(value), 0), leadingKind: 'object' });
  assert.ok(!JSON.stringify(shape).includes('PRIVATE_OUTPUT_CANARY'));
});
test('thinking, tool arguments, errors and empty response remain outside visible text metadata', () => {
  let shape = nativeTextOutputShape({ private: 'PRIVATE_OUTPUT_CANARY' }, null);
  for (const frame of [
    { type: 'content_block_start', content_block: { type: 'thinking', thinking: 'PRIVATE_OUTPUT_CANARY' } },
    { type: 'content_block_delta', delta: { type: 'thinking_delta', thinking: 'PRIVATE_OUTPUT_CANARY' } },
    { type: 'content_block_delta', delta: { type: 'input_json_delta', partial_json: 'PRIVATE_OUTPUT_CANARY' } },
    { type: 'error', message: 'PRIVATE_OUTPUT_CANARY' },
  ]) shape = nativeTextOutputShape(shape, frame);
  assert.deepEqual(shape, { fragmentBytes: 0, leadingKind: 'empty' });
  assert.deepEqual(nativeTextOutputShape(shape, { type: 'content_block_delta', delta: { type: 'text_delta', text: '```json' } }),
    { fragmentBytes: 7, leadingKind: 'fence' });
});
