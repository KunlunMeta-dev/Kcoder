import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import test from 'node:test';
import { extractWorkflowDescription } from './workflow-description-source.mjs';
test('real historical description identity is decoded, including escapes and Unicode', () => {
  const source = execFileSync('git', ['show', 'e6bc92645:crates/kcoder_tools/src/workflow_draft.rs'], { encoding: 'utf8' });
  const description = extractWorkflowDescription(source);
  assert.equal([...description].length, 13831);
  assert.equal(Buffer.byteLength(description), 13839);
  assert.ok(description.includes('expected_revision'));
});
test('unsupported literal cannot silently become invented old description', () => {
  assert.throws(() => extractWorkflowDescription('fn description(&self) -> String { load_prompt() }'));
});

test('actual Anthropic cache fields count toward context while OpenAI input already includes cache', async () => {
  const { contextInputUsage } = await import('./workflow-description-source.mjs');
  assert.equal(contextInputUsage([{ usageEvents: [{ input_tokens: 0 }, { input_tokens: 249, cache_read_input_tokens: 7808 }] }], 'anthropic_messages'), 8057);
  assert.equal(contextInputUsage([{ usageEvents: [{ input_tokens: 8057, cache_read_input_tokens: 7808 }] }], 'openai_chat_completions'), 8057);
  assert.throws(() => contextInputUsage([], 'unknown_format'));
});
