import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { parseIntent } from './forge.mjs';

export const MARKERS = Object.freeze({ owner: 'OWNED_REVIEW_A', ownerDone: 'OWNER_REVIEW_READY',
  b: 'OWNED_ALTERNATIVE_B', c: 'OWNED_ALTERNATIVE_C', bDone: 'ALL_CHECKS_PASSED_FIXTURE_B',
  cDone: 'ALL_CHECKS_PASSED_FIXTURE_C', published: 'OWNED_LOCAL_PUBLICATION_COMPLETE', fixed: 'OWNED_CI_FIX_COMMITTED' });
export const CONTENT = Object.freeze({ b: 'owned alternative B\n', c: 'owned alternative C\n', fixed: 'owned alternative B fixed from selected CI evidence\n' });
const quote = value => `'${String(value).replaceAll("'", "'\\''")}'`;
export const quotePowerShell = value => `'${String(value).replaceAll("'", "''")}'`;
function text(content) { return typeof content === 'string' ? content : (content ?? []).map(part => part.text ?? '').join('\n'); }
function call(id, name, args) {
  return [{ delta: { role: 'assistant', tool_calls: [{ index: 0, id, type: 'function', function: { name, arguments: JSON.stringify(args) } }] }, finishReason: 'tool_calls' }];
}
function done(marker) { return [{ delta: { role: 'assistant', content: marker }, finishReason: 'stop' }]; }
export function taskDeliveryResponses({ deadline = Date.now() + 300_000, maxRequests = 16, actionsPath = fileURLToPath(new URL('./actions.mjs', import.meta.url)),
  platform = process.platform, gitProof, nodePath = process.execPath } = {}) {
  const windows = platform === 'win32';
  if (windows) assert.ok(gitProof?.path && /^[a-f0-9]{64}$/.test(gitProof.sha256), 'fixed Windows Git executable proof required');
  const actionCommand = (action, payload) => {
    const args = [nodePath, actionsPath, action, Buffer.from(JSON.stringify(payload)).toString('base64url')];
    if (gitProof) args.push(Buffer.from(JSON.stringify(gitProof)).toString('base64url'));
    return windows ? `& ${args.map(quotePowerShell).join(' ')}; exit $LASTEXITCODE` : args.map(quote).join(' ');
  };
  return ({ requestNumber, body }) => {
    assert.ok(requestNumber <= maxRequests && Date.now() <= deadline, 'owned protocol fixture request/time budget exceeded');
    const messages = body.messages ?? []; const lastUser = messages.findLastIndex(message => message.role === 'user');
    const prompt = text(messages[lastUser]?.content); const results = messages.slice(lastUser + 1).filter(message => message.role === 'tool').length;
    if (prompt.includes('Investigate this selected failed CI check')) {
      if (results === 0) return call('delivery-fix-read', 'read', { file_path: 'alternative.txt' });
      if (results === 1) return call('delivery-fix-write', 'write', { file_path: 'alternative.txt', content: CONTENT.fixed });
      if (results === 2) return call('delivery-fix-commit', windows ? 'PowerShell' : 'bash', { command: windows ? actionCommand('fix', {}) : "git add -- alternative.txt && git -c commit.gpgsign=false commit -m 'fix: selected owned CI failure'", timeout: 10000 });
      return done(MARKERS.fixed);
    }
    if (prompt.includes('Publish the following explicitly requested delivery')) {
      if (results === 0) {
        const intent = parseIntent(prompt);
        return call('delivery-publish-explicit', windows ? 'PowerShell' : 'bash', { command: actionCommand('publish', intent), timeout: 10000 });
      }
      return done(MARKERS.published);
    }
    const variant = prompt.includes(MARKERS.b) ? 'b' : prompt.includes(MARKERS.c) ? 'c' : null;
    if (variant) {
      if (results === 0) return call(`alternative-${variant}-write`, 'write', { file_path: 'alternative.txt', content: CONTENT[variant] });
      if (results === 1) return call(`alternative-${variant}-commit-and-check`, windows ? 'PowerShell' : 'bash', {
        command: windows ? actionCommand('candidate', { variant }) : `git add -- alternative.txt && git -c commit.gpgsign=false commit -m 'feat: owned alternative ${variant.toUpperCase()}' && printf 'OWNED_CHECK_${variant.toUpperCase()}\\n'; exit ${variant === 'b' ? 7 : 0}`,
        timeout: 10000,
      });
      // Deliberate contradiction proves Native exit evidence is independent of model prose.
      return done(variant === 'b' ? MARKERS.bDone : MARKERS.cDone);
    }
    if (prompt.includes(MARKERS.owner)) {
      if (results === 0) return call('owner-review-write', 'write', { file_path: 'owner-result.txt', content: 'Owned original task result; existing dirty user file must survive.\n' });
      return done(MARKERS.ownerDone);
    }
    throw new Error('unexpected prompt reached the fixed task-delivery fixture');
  };
}
