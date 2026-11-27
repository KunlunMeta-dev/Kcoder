import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile, mkdir } from 'node:fs/promises';
import { runE2E, requireExecutable } from '../harness/run-context.mjs';

assert.equal(process.env.KCODER_E2E_WEB_EXTERNAL_NETWORK, '1', 'explicit public-provider consent required');
const binary = await requireExecutable(process.env.KCODER_E2E_SEARCH_CONSTRAINTS_BIN, 'native constraint probe');
const expected = process.env.KCODER_E2E_SEARCH_CONSTRAINTS_SHA256;
assert.match(expected ?? '', /^[a-f0-9]{64}$/);
assert.equal(createHash('sha256').update(await readFile(binary)).digest('hex'), expected);
await runE2E(import.meta.url, {
  testId: 'public-native-search-region-and-publication-constraints', tier: 'external-provider', retainSuccessLogs: true,
  modelPolicy: 'Three fixed public queries through native runtime and anonymous advanced source; no model/search credentials, no quality score.',
}, async context => {
  const profile = context.pathInState('profile');
  await mkdir(profile, { mode: 0o700 });
  const env = { KCODER_E2E_WEB_EXTERNAL_NETWORK: '1', KCODER_CONFIG_DIR: profile };
  for (const name of ['HTTP_PROXY','HTTPS_PROXY','ALL_PROXY','NO_PROXY','http_proxy','https_proxy','all_proxy','no_proxy','SSL_CERT_FILE','SSL_CERT_DIR','CURL_CA_BUNDLE']) {
    if (process.env[name] !== undefined) { env[name] = process.env[name]; if (/proxy/i.test(name) && !/^no_proxy$/i.test(name)) context.registerSecret(env[name]); }
  }
  const child = context.spawnOwned('native-constraints', binary, [], { cwd: profile, env, stdin: 'ignore' });
  let stdout = '', size = 0;
  const done = new Promise((resolve, reject) => {
    child.stdout.on('data', chunk => { size += chunk.length; if (size > 512 * 1024) { void context.stopOwned('native-constraints'); reject(Error('Native constraint evidence exceeded byte budget')); } else stdout += chunk; });
    child.once('error', reject); child.once('close', resolve);
  });
  const timer = setTimeout(() => { void context.stopOwned('native-constraints'); }, 210000);
  let code; try { code = await done; } finally { clearTimeout(timer); }
  const result = JSON.parse(stdout.trim());
  await context.writeArtifactJson('public-constraints.json', { ...result, exitCode: code });
  assert.equal(result.modelCalls, 0); assert.equal(result.logicalRequests, 3); assert.equal(result.searchKeyUsed, false);
  for (const sample of result.cases) {
    for (const hit of sample.response?.page?.results ?? []) {
      const url = new URL(hit.url);
      assert.ok(['https:', 'http:'].includes(url.protocol) && !url.username && !url.password);
      assert.ok(sample.input.allowed_domains.some(domain => url.hostname === domain || url.hostname.endsWith(`.${domain}`)), 'actual public results must preserve the exact input domain ceiling');
      if (sample.input.time_range) assert.ok(hit.publishedAt, 'time-constrained results must retain their actual date evidence');
    }
  }
  assert.equal(code, 0); assert.equal(result.passed, true);
  return result;
});
