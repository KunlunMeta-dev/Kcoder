import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { waitFor } from './run-context.mjs';

export function normalizeComposerText(value) {
  return String(value).replace(/\r\n/g, '\n').trimEnd();
}
export function composerTextDigest(value) {
  const text = normalizeComposerText(value);
  return { bytes: Buffer.byteLength(text), sha256: createHash('sha256').update(text).digest('hex') };
}
export async function readComposerText(page, { testId = 'chat-message-input' } = {}) {
  return normalizeComposerText(await page.getByTestId(testId).innerText());
}

/** Use actual editor key events: one ProseMirror paragraph represents newlines as hard breaks. */
export async function fillComposerText(page, value, { testId = 'chat-message-input', timeoutMs = 15000, signal } = {}) {
  assert.equal(typeof value, 'string');
  const expected = normalizeComposerText(value);
  assert.ok(Buffer.byteLength(expected) <= 64 * 1024, 'owned composer input exceeds the fixture byte budget');
  const input = page.getByTestId(testId);
  await input.waitFor({ state: 'visible', timeout: timeoutMs });
  if (!expected.includes('\n')) await input.fill(expected);
  else {
    await input.click();
    await page.keyboard.press(process.platform === 'darwin' ? 'Meta+A' : 'Control+A');
    await page.keyboard.press('Backspace');
    const lines = expected.split('\n');
    for (let index = 0; index < lines.length; index++) {
      if (index) await page.keyboard.press('Shift+Enter');
      if (lines[index]) await page.keyboard.insertText(lines[index]);
    }
  }
  await waitFor(async () => await readComposerText(page, { testId }) === expected,
    timeoutMs, `owned composer document mismatch (${JSON.stringify(composerTextDigest(expected))})`, 25, signal);
  return expected;
}

/** Match Native prompt_from_params without logging complete user or publication prompt bodies. */
export function nativeTurnText(params) {
  if (typeof params?.prompt === 'string') return params.prompt;
  return Array.isArray(params?.input)
    ? params.input.map(item => item?.text).filter(value => typeof value === 'string').join('\n')
    : '';
}

export function composerTextDifference(expectedValue, actualValue) {
  const expected = normalizeComposerText(expectedValue); const actual = normalizeComposerText(actualValue);
  let offset = 0;
  while (offset < expected.length && offset < actual.length && expected[offset] === actual[offset]) offset++;
  return { expected: composerTextDigest(expected), actual: composerTextDigest(actual), exact: expected === actual,
    firstDifference: expected === actual ? null : { offset, expectedCodePoint: expected.codePointAt(offset) ?? null, actualCodePoint: actual.codePointAt(offset) ?? null },
    expectedLines: expected.split('\n').map(line => line.length), actualLines: actual.split('\n').map(line => line.length) };
}

/** Read-only document/selection diagnostics; retain digests and structure, never prompt bodies. */
export async function readComposerDiagnostics(page, { testId = 'chat-message-input' } = {}) {
  const input = page.getByTestId(testId);
  const [rendered, textContent, paragraphs, hardBreaks, state] = await Promise.all([
    input.innerText(), input.textContent(), input.locator('p').count(), input.locator('br').count(),
    input.evaluate(element => {
      const selection = element.ownerDocument.getSelection();
      return { serialized: typeof element.value === 'string' ? element.value : null,
        selection: selection ? { collapsed: selection.isCollapsed, anchorInside: element.contains(selection.anchorNode),
          focusInside: element.contains(selection.focusNode), anchorOffset: selection.anchorOffset, focusOffset: selection.focusOffset } : null };
    }),
  ]);
  return { rendered: composerTextDigest(rendered), textContent: composerTextDigest(textContent ?? ''),
    serialized: state.serialized == null ? null : composerTextDigest(state.serialized), paragraphs, hardBreaks, selection: state.selection };
}
