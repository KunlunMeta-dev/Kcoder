import assert from 'node:assert/strict';
import test from 'node:test';

import {
  focusTerminal,
  pressTerminalEscape,
  readComposerText,
  readShellComposerText,
  submitTerminalLine,
  tryWaitForTerminalText,
  tryWaitForTerminalTextMissing,
  typeHumanText,
  waitForComposerText,
  waitForShellComposerText,
  waitForTerminalText,
  waitForTerminalTextCount,
  waitForTerminalTextMissing,
  waitForTerminalTextPattern,
  waitForTerminalTextState,
} from '../lib/terminal-interaction.mjs';

function fakePage(text = '') {
  const events = [];
  let terminalText = text;
  let waitError = null;
  const tuiLab = {
    text: () => terminalText,
    focus: () => events.push(['focus']),
    sendInput: (data) => events.push(['sendInput', data]),
  };
  const withWindow = async (fn, arg) => {
    const previous = globalThis.window;
    globalThis.window = { tuiLab };
    try {
      return await fn(arg);
    } finally {
      globalThis.window = previous;
    }
  };
  return {
    events,
    setText(value) {
      terminalText = value;
    },
    failWait(error = new Error('timeout')) {
      waitError = error;
    },
    keyboard: {
      async insertText(value) {
        events.push(['insertText', value]);
      },
    },
    async waitForTimeout(timeout) {
      events.push(['waitForTimeout', timeout]);
    },
    locator(selector) {
      events.push(['locator', selector]);
      return {
        async click() {
          events.push(['click', selector]);
        },
      };
    },
    async evaluate(fn, arg) {
      events.push(['evaluate', arg]);
      return withWindow(fn, arg);
    },
    async waitForFunction(fn, arg, options) {
      events.push(['waitForFunction', arg, options]);
      if (waitError) throw waitError;
      if (!(await withWindow(fn, arg))) throw new Error('condition was false');
    },
  };
}

test('passes terminal wait parameters in order and honors pattern and minimum-count semantics', async () => {
  const page = fakePage('昆仑 sentinel sentinel');
  await waitForTerminalText(page, '昆仑', 101);
  await waitForTerminalTextMissing(page, 'missing', 102);
  await waitForTerminalTextState(page, '昆仑', true, 103);
  await waitForTerminalTextPattern(page, '昆. sentinel', 104);
  await waitForTerminalTextCount(page, 'sentinel', 2, 105);
  assert.deepEqual(
    page.events.filter(([name]) => name === 'waitForFunction').map(([, arg, options]) => [arg, options]),
    [
      ['昆仑', { timeout: 101 }],
      ['missing', { timeout: 102 }],
      [{ needle: '昆仑', present: true }, { timeout: 103 }],
      ['昆. sentinel', { timeout: 104 }],
      [{ expectedText: 'sentinel', minCount: 2 }, { timeout: 105 }],
    ],
  );
});

test('types Unicode code points individually with the stable human delay', async () => {
  const page = fakePage();
  await typeHumanText(page, 'A昆🙂');
  assert.deepEqual(page.events, [
    ['insertText', 'A'],
    ['waitForTimeout', 20],
    ['insertText', '昆'],
    ['waitForTimeout', 20],
    ['insertText', '🙂'],
    ['waitForTimeout', 20],
  ]);
});

test('focuses, types, waits, and submits CR in the established order', async () => {
  const page = fakePage();
  await submitTerminalLine(page, 'go');
  assert.deepEqual(page.events, [
    ['locator', '#terminal'],
    ['click', '#terminal'],
    ['evaluate', undefined],
    ['focus'],
    ['insertText', 'g'],
    ['waitForTimeout', 20],
    ['insertText', 'o'],
    ['waitForTimeout', 20],
    ['waitForTimeout', 120],
    ['evaluate', undefined],
    ['sendInput', '\r'],
  ]);
});

test('uses legacy Windows ESC and Kitty Unix ESC', async () => {
  const windows = fakePage();
  const unix = fakePage();
  await pressTerminalEscape(windows, 'win32');
  await pressTerminalEscape(unix, 'linux');
  assert.deepEqual(windows.events.at(-1), ['sendInput', '\u001b']);
  assert.deepEqual(unix.events.at(-1), ['sendInput', '\u001b[27u']);
});

test('try-wait helpers convert wait failures to false', async () => {
  const page = fakePage('ready');
  assert.equal(await tryWaitForTerminalText(page, 'ready', 10), true);
  assert.equal(await tryWaitForTerminalTextMissing(page, 'gone', 10), true);
  page.failWait();
  assert.equal(await tryWaitForTerminalText(page, 'ready', 10), false);
  assert.equal(await tryWaitForTerminalTextMissing(page, 'gone', 10), false);
});

test('reads the last composer and preserves shell multiline boundaries and whitespace matching', async () => {
  const page = fakePage(
    ['› old draft', 'answer', '  › newest draft', '! old shell', '', ' ! echo one', '  two   words  ', 'Shell mode'].join(
      '\n',
    ),
  );
  assert.equal(await readComposerText(page), '  › newest draft');
  await waitForComposerText(page, 'newest', 20);
  assert.equal(await readShellComposerText(page), 'echo one\ntwo   words');
  await waitForShellComposerText(page, 'echoone two words', 20);
  await focusTerminal(page);
  assert.deepEqual(page.events.slice(-4), [
    ['locator', '#terminal'],
    ['click', '#terminal'],
    ['evaluate', undefined],
    ['focus'],
  ]);
});
