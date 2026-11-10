import { expect, it } from 'vitest';
import { normalizeMessage, structuredBlocks } from './task-runtime/normalizers';

it('preserves repeated historical commentary while assigning distinct deterministic block identities', () => {
  const blocks = [
    { type: 'text', id: 'first-message-text', content: 'same commentary' },
    { type: 'tool', id: 'call-a', tool_name: 'Read', status: 'done' },
    { type: 'text', id: 'first-message-text', content: 'same commentary' },
    { type: 'tool', id: 'call-b', tool_name: 'Read', status: 'done' },
    { type: 'text', id: 'first-message-text', content: 'different commentary' },
  ];
  const input = { id: 'reply', role: 'assistant', content: 'final answer', timestampMs: 1, blocks };
  const message = normalizeMessage(input)!;
  const ordered = message.orderedBlocks!;
  expect(new Set(ordered.map(block => `${block.kind}:${block.id}`)).size).toBe(ordered.length);
  expect(ordered.filter(block => block.kind === 'text').map(block => block.content)).toEqual([
    'same commentary', 'same commentary', 'different commentary', 'final answer',
  ]);
  expect(normalizeMessage(input)?.orderedBlocks).toEqual(ordered);
  expect(blocks[2].id).toBe('first-message-text');
});

it('keeps valid historical IDs unchanged and avoids IDs already present in the payload', () => {
  const result = structuredBlocks([
    { type: 'text', id: 'same', content: 'one' },
    { type: 'text', id: 'same', content: 'two' },
    { type: 'text', id: 'same:history-occurrence-2', content: 'three' },
    { type: 'thinking', id: 'thought', content: 'before' },
    { type: 'thinking', id: 'thought', content: 'after' },
  ]).orderedBlocks;
  expect(result[0].id).toBe('same');
  expect(result[2].id).toBe('same:history-occurrence-2');
  expect(result[3].id).toBe('thought');
  expect(new Set(result.map(block => `${block.kind}:${block.id}`)).size).toBe(result.length);
});

it('keeps a real block distinct from the generated final-content identity', () => {
  const message = normalizeMessage({ id: 'reply', role: 'assistant', timestampMs: 1,
    content: 'final answer', blocks: [{ type: 'text', id: 'reply:content', content: 'earlier commentary' }] })!;
  expect(message.orderedBlocks?.map(block => block.id)).toEqual(['reply:content', 'reply:content:history-occurrence-2']);
  expect(message.orderedBlocks?.map(block => block.kind === 'text' && block.content)).toEqual(['earlier commentary', 'final answer']);
});
