import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { INSTRUCTION_METHODS as M, validInstructionCall, validInstructionSourceCall } from '../shared/migrationInstructions.mjs';
const captureId = 'bdaeb662-a7fe-4412-974c-18c4f9e78005';
const target = { kind: 'source', captureId };
const item = { itemId: 'instruction-owned', displayName: 'CLAUDE.md', source: 'claude-code', scoped: true, formatRevision: 'scoped-instructions/v2', sourceRevision: 'a'.repeat(64), relativePath: 'CLAUDE.md', relativeScope: '', role: 'shared', trigger: 'launch', disposition: 'selected', bytes: 5, completeAuthorizedStaticChain: true, reasonCode: null };
const input = { target, pageIndex: 0 }, page = { target, pageIndex: 0, items: [item], totalItems: 1, nextPage: null };

test('static source capture needs explicit consent and can never import filesystem proof or execution authority', () => {
  const params = { captureId, source: 'claude-code', format: 'static_v2', sourceRoot: '/owned/root', sourceCwd: '/owned/root/project', confirmStaticSubset: true };
  const result = { captureId, source: 'claude-code', formatRevision: 'scoped-instructions/v2', sourceRevision: 'a'.repeat(64), totalItems: 1, completeAuthorizedStaticChain: true, dynamicScopePresent: false, remainingMs: 600000 };
  assert.ok(validInstructionCall(M.capture, params, result));
  for (const request of [{ ...params, confirmStaticSubset: false }, { ...params, sourceRoot: ' ' }, { ...params, profileIdentity: 'forged' }]) assert.equal(validInstructionCall(M.capture, request), false);
  for (const reply of [{ ...result, captureId: 'peer' }, { ...result, source: 'codex' }, { ...result, formatRevision: 'scoped-instructions/v1' }, { ...result, totalItems: 129 }]) assert.equal(validInstructionCall(M.capture, params, reply), false);
});

test('scope pages retain exact capture identity, ten-item boundaries and explicit legacy unknown state', () => {
  assert.ok(validInstructionSourceCall(M.page, input, page));
  for (const value of [{ ...page, target: { kind: 'source', captureId: 'peer' } }, { ...page, nextPage: 2 }, { ...page, totalItems: 12 }, { ...page, items: [item, item] }, { ...page, items: [{ ...item, relativeScope: '../outside' }] }]) assert.equal(validInstructionCall(M.page, input, value), false);
  const job = { kind: 'job', jobId: 'mig-' + 'a'.repeat(32) };
  const legacy = { ...item, scoped: false, formatRevision: null, sourceRevision: null, relativePath: null, relativeScope: null, role: null, trigger: null, bytes: null, completeAuthorizedStaticChain: false, disposition: 'requires_review', reasonCode: 'migration_instruction_legacy_scope_unobserved' };
  assert.ok(validInstructionCall(M.page, { target: job }, { ...page, target: job, items: [legacy] }));
  assert.equal(validInstructionSourceCall(M.page, { target: job }), false);
  assert.equal(validInstructionCall(M.page, input, { ...page, items: [legacy] }), false);
});

test('body windows reject forged UTF8, cursor/representation jumps, oversized bytes and preview activation', () => {
  const request = { target, itemId: item.itemId, representation: 'original', offset: 0 };
  const body = { target, itemId: item.itemId, representation: 'original', formatRevision: 'scoped-instructions/v2', offset: 0, encoding: 'utf8', bytesBase64: 'Z3VpZGU=', text: 'guide', totalBytes: 5, sha256: createHash('sha256').update('guide').digest('hex'), nextOffset: null, enabledByPreview: false };
  assert.ok(validInstructionCall(M.body, request, body));
  for (const value of [{ ...body, enabledByPreview: true }, { ...body, text: 'forged' }, { ...body, representation: 'compiled' }, { ...body, nextOffset: 6 }, { ...body, offset: 1 }, { ...body, bytesBase64: btoa('x'.repeat(16385)), text: 'x'.repeat(16385), totalBytes: 16385 }]) assert.equal(validInstructionCall(M.body, request, value), false);
  const binary = { ...body, encoding: 'binary', bytesBase64: '/w==', totalBytes: 1 };
  delete binary.text;
  assert.ok(validInstructionCall(M.body, request, binary));
  assert.equal(validInstructionCall(M.body, { ...request, representation: 'compiled' }, { ...binary, representation: 'compiled' }), false);
});
