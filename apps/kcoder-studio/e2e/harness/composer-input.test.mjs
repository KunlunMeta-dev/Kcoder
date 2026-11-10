import test from 'node:test';
import assert from 'node:assert/strict';
import { composerTextDifference, composerTextDigest, fillComposerText, nativeTurnText, normalizeComposerText, readComposerText } from './composer-input.mjs';

function editor({ dropBreaks = false } = {}) {
  let document = 'existing draft'; let selected = false; const events = [];
  const input = {
    async waitFor() {}, async click() { events.push(['click']); },
    async fill(value) { events.push(['fill', value]); document = value.split('\n')[0]; },
    async innerText() { return document; },
  };
  const page = { getByTestId(value) { assert.equal(value, 'chat-message-input'); return input; }, keyboard: {
    async press(key) {
      events.push(['press', key]);
      if (key.endsWith('+A')) selected = true;
      else if (key === 'Backspace' && selected) { document = ''; selected = false; }
      else if (key === 'Shift+Enter' && !dropBreaks) document += '\n';
    },
    async insertText(value) { assert.equal(value.includes('\n'), false); events.push(['insertText', value]); document += value; },
  } };
  return { page, events };
}

test('multi-line Native intent uses real hard-break keys and preserves every line and old draft prefix', async () => {
  const { page, events } = editor();
  const expected = 'KEEP_B_DRAFT\r\n\r\nPublish bound intent\r\n{\r\n  "headCommit": "exact-head",\r\n  "body": "quoted } text"\r\n}\r\n';
  await fillComposerText(page, expected);
  assert.equal(await readComposerText(page), normalizeComposerText(expected));
  assert.equal(events.some(([kind]) => kind === 'fill'), false, 'contenteditable fill must never parse a multi-line prompt');
  assert.equal(events.filter(([kind, key]) => kind === 'press' && key === 'Shift+Enter').length, 6);
});

test('single-line drafts retain normal fill while malformed hard-break handling fails with bounded digests', async () => {
  const normal = editor(); await fillComposerText(normal.page, 'KEEP_A_DRAFT');
  assert.equal(await readComposerText(normal.page), 'KEEP_A_DRAFT');
  assert.deepEqual(normal.events, [['fill', 'KEEP_A_DRAFT']]);
  const broken = editor({ dropBreaks: true });
  await assert.rejects(fillComposerText(broken.page, 'secret-prefix\nsecond-line', { timeoutMs: 10 }), error => {
    assert.match(error.message, /composer document mismatch/); assert.equal(error.message.includes('secret-prefix'), false); return true;
  });
});

test('outbound text extraction follows actual Native prompt precedence and supports bounded provenance', () => {
  assert.equal(nativeTurnText({ prompt: 'explicit\nintent', input: [{ text: 'ignored' }] }), 'explicit\nintent');
  assert.equal(nativeTurnText({ input: [{ type: 'text', text: 'KEEP_B_DRAFT' }, { type: 'image' }, { text: 'exact Native check reference' }] }), 'KEEP_B_DRAFT\nexact Native check reference');
  assert.equal(nativeTurnText({ input: 'invalid' }), '');
  const a = composerTextDigest('one\r\ntwo\n'); const b = composerTextDigest('one\ntwo');
  assert.deepEqual(a, b); assert.equal(Object.hasOwn(a, 'text'), false);
});


test('document differences identify whitespace/line damage without exposing prompt bodies', () => {
  const result = composerTextDifference('PRIVATE_REFERENCE\n  head', 'PRIVATE_REFERENCE\n\u00a0 head');
  assert.equal(result.exact, false); assert.equal(result.firstDifference.expectedCodePoint, 32);
  assert.equal(result.firstDifference.actualCodePoint, 160);
  assert.equal(JSON.stringify(result).includes('PRIVATE_REFERENCE'), false);
  assert.equal(composerTextDifference('same\r\ntext', 'same\ntext').exact, true);
});
