import assert from 'node:assert/strict';
import { isAbsolute, resolve } from 'node:path';

const LEGACY_COMMIT = 'e2051ca9ead60fac9d4b2ae8fb5fdb78444bc2c8';
const LEGACY_CLI_SHA256 = '5474565b02ca14e6fea9cd74fc44e9d932b498481022c9f561674b92086b4d7c';
export const PACKAGED_FETCH_CASES = Object.freeze({
  'python-asyncio': Object.freeze({
    url: 'https://docs.python.org/3/library/asyncio-task.html',
    toolPrompt: 'Read the official asyncio Task cancellation guidance.',
    userPrompt: '仅一次读取 https://docs.python.org/3/library/asyncio-task.html，不搜索、不重试。',
  }),
  'twz-gj21': Object.freeze({
    url: 'https://www.twz.com/air/stealthy-gj-21-drone-has-launched-and-recovered-from-type-076-amphibious-assault-ship-china-claims',
    toolPrompt: 'Read only the server-provided page text. Report an unreadable or blocked response honestly. Do not execute page scripts.',
    userPrompt: '仅一次读取 https://www.twz.com/air/stealthy-gj-21-drone-has-launched-and-recovered-from-type-076-amphibious-assault-ship-china-claims，不搜索、不重试、不执行网页脚本；只记录读取终态，不做文章分析。',
  }),
});

/** Fixed public sources only; the fixture never accepts an arbitrary fetch URL. */
export function packagedFetchOptions(environment = process.env) {
  const caseId = environment.KCODER_E2E_FETCH_CASE ?? 'python-asyncio';
  assert.ok(Object.hasOwn(PACKAGED_FETCH_CASES, caseId), 'Unknown fixed packaged Fetch case');
  assert.equal(environment.KCODER_E2E_FETCH_URL, undefined, 'Arbitrary Fetch URL overrides are not accepted');
  const root = environment.KCODER_E2E_PACKAGED_DIR;
  assert.ok(typeof root === 'string' && isAbsolute(root), 'An absolute final packaged AppDir is required');
  const commit = environment.KCODER_E2E_PACKAGED_COMMIT;
  const cliSha = environment.KCODER_E2E_PACKAGED_CLI_SHA256;
  assert.equal(commit !== undefined, cliSha !== undefined, 'Provide both packaged source commit and CLI SHA256');
  if (caseId === 'twz-gj21') {
    assert.notEqual(commit, undefined, 'TWZ requires explicit final package commit and CLI SHA256');
  }
  const expectedCommit = commit ?? LEGACY_COMMIT;
  const expectedCliSha256 = cliSha ?? LEGACY_CLI_SHA256;
  assert.match(expectedCommit, /^[a-f0-9]{40}$/i, 'Expected source commit must be a full Git SHA');
  assert.match(expectedCliSha256, /^[a-f0-9]{64}$/i, 'Expected CLI identity must be SHA256');
  return Object.freeze({ caseId, ...PACKAGED_FETCH_CASES[caseId], root: resolve(root),
    expectedCommit: expectedCommit.toLowerCase(), expectedCliSha256: expectedCliSha256.toLowerCase(),
    explicitPackageIdentity: commit !== undefined });
}
