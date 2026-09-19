import assert from 'node:assert/strict';
import test from 'node:test';

import { renderTerminalPage } from '../lib/terminal-page.mjs';

test('reports context loss instead of keeping a stale webgl renderer label', () => {
  const html = renderTerminalPage({ cols: 100, rows: 32 });
  assert.match(html, /webglAddon\.onContextLoss\(/);
  assert.match(html, /get renderer\(\)/);
  assert.match(html, /renderer = 'webgl-context-lost'/);
  assert.match(html, /rendererDiagnostics\(\)/);
  assert.match(html, /isContextLost\(\)/);
});

test('renders the configured terminal geometry and renderer fallback contract', () => {
  const html = renderTerminalPage({ cols: 93, rows: 27 });
  assert.match(html, /cols: 93,/);
  assert.match(html, /rows: 27,/);
  assert.match(html, /scrollback: 10000,/);
  assert.match(html, /new WebglAddon\.WebglAddon\(\)/);
  assert.match(html, /renderer = 'dom-fallback:' \+ String/);
});

test('preserves PTY input, resize, and active-buffer inspection contracts', () => {
  const html = renderTerminalPage({ cols: 100, rows: 32 });
  assert.match(html, /new WebSocket\('ws:\/\/' \+ window\.location\.host \+ '\/pty'\)/);
  assert.match(html, /JSON\.stringify\(\{ type: 'input', data \}\)/);
  assert.match(html, /JSON\.stringify\(\{ type: 'resize', cols: term\.cols, rows: term\.rows \}\)/);
  assert.match(html, /const buffer = term\.buffer\.active;/);
  assert.match(html, /visibleText\(\) \{/);
  assert.match(html, /buffer\.getLine\(viewportY \+ row\)/);
  assert.match(html, /dimensions\(\) \{/);
  assert.match(html, /internalScrollbar\(\) \{/);
  assert.match(html, /chars === '│'/);
  assert.match(html, /chars === '┃'/);
  assert.match(html, /async viewportDiagnostics\(afterSequence = 0\)/);
  assert.match(html, /fetch\('\/viewport-diagnostics\?after=' \+ encodeURIComponent\(afterSequence\)/);
});

test('preserves copy-selection handling and resize fitting', () => {
  const html = renderTerminalPage({ cols: 100, rows: 32 });
  assert.match(html, /term\.attachCustomKeyEventHandler/);
  assert.match(html, /\(event\.ctrlKey \|\| event\.metaKey\)/);
  assert.match(html, /event\.key\.toLowerCase\(\) === 'c'/);
  assert.match(html, /term\.hasSelection\(\)/);
  assert.match(html, /return !copySelection;/);
  assert.match(html, /function fitAndReport\(\) \{\s+fitAddon\.fit\(\);/);
  assert.match(html, /window\.addEventListener\('resize', fitAndReport\)/);
});
