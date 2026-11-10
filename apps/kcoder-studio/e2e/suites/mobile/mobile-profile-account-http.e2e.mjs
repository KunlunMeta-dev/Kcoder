import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { networkInterfaces } from 'node:os';
import { readFile } from 'node:fs/promises';
import { resolve, relative } from 'node:path';
import { createHash } from 'node:crypto';
import { runE2E, repoRoot, waitFor } from '../../harness/run-context.mjs';
import { startChromium } from '../../harness/chromium.mjs';
import { startFixtureSite } from '../../harness/fixture-site.mjs';
const { build, stop } = createRequire(resolve(repoRoot, 'apps/kcoder-studio/mobile/package.json'))('esbuild');
const hash = value => createHash('sha256').update(value).digest('hex');

await runE2E(import.meta.url, { testId: 'mobile-profile-account-http-identity', tier: 'full-integration', modelPolicy: 'model-independent actual insecure HTTP/IndexedDB/production profile modules with synthetic refresh response boundaries; not a Gateway or complete Mobile UI acceptance claim' }, async context => {
  context.addCleanup('stop owned profile fixture compiler', () => stop());
  const host = Object.values(networkInterfaces()).flat().find(entry => entry && entry.family === 'IPv4' && !entry.internal)?.address;
  assert.ok(host, 'UNMET_PREREQUISITE: actual non-loopback HTTP interface');
  const output = await build({ entryPoints: [resolve(repoRoot, 'apps/kcoder-studio/e2e/suites/mobile/mobile-profile-account.fixture.ts')], absWorkingDir: repoRoot, bundle: true, platform: 'browser', format: 'esm', write: false, metafile: true, tsconfig: resolve(repoRoot, 'apps/kcoder-studio/mobile/tsconfig.json'), plugins: [{ name: 'owned-profile-web-platform', setup(builder) { builder.onResolve({ filter: /^react-native$/ }, () => ({ path: 'react-native', namespace: 'owned-web-platform' })); builder.onLoad({ filter: /.*/, namespace: 'owned-web-platform' }, () => ({ contents: 'export const Platform = { OS: "web" };', loader: 'js' })); } }] });
  stop(); // The generated module no longer needs the owned compiler service.
  const files = Object.keys(output.metafile.inputs).filter(path => !path.startsWith('owned-web-platform:')).sort();
  const inputs = await Promise.all(files.map(async path => ({ path: relative(repoRoot, resolve(repoRoot, path)), sha256: hash(await readFile(resolve(repoRoot, path))) })));
  const site = await startFixtureSite(context, { host, assets: { '/profile-account.mjs': { contentType: 'text/javascript; charset=utf-8', body: output.outputFiles[0].text } } });
  const browser = await startChromium(context, { label: 'profile-account-http-browser' });
  const a = await browser.newPersistentPage(), b = await browser.newPersistentPage();
  for (const page of [a, b]) {
    await page.goto(site.url);
    await page.evaluate(async () => { if (isSecureContext || navigator.locks !== undefined) throw Error('Expected ordinary HTTP without Web Locks'); await import('/profile-account.mjs'); });
  }
  assert.equal(await a.evaluate(() => fixture.legacyCreationCoordinated()), false, 'unmigrated unlinked creation remains blocked on actual ordinary HTTP');
  await a.evaluate(async () => { await fixture.seed(); await fixture.restore(); }); await b.evaluate(() => fixture.restore());
  await a.evaluate(() => fixture.beginRefresh());
  await waitFor(() => a.evaluate(() => fixture.state().requests.length === 1), 3000, 'first original durable rotation');
  await b.evaluate(() => fixture.beginRefresh());
  await waitFor(() => b.evaluate(() => fixture.state().requests.length === 1), 3000, 'peer same canonical rotation');
  const firstId = await a.evaluate(() => fixture.state().requests[0]);
  assert.equal(await b.evaluate(() => fixture.state().requests[0]), firstId);
  await Promise.all([a.evaluate(() => fixture.finishRefresh()), b.evaluate(() => fixture.finishRefresh())]);
  for (const page of [a, b]) assert.equal(await page.evaluate(() => fixture.state().refreshOutcome), 'accepted');
  assert.deepEqual(await a.evaluate(() => fixture.durable()), [{ id: 'primary', generation: 'generation-one', pending: false }, { id: 'unrelated', generation: 'generation-one', pending: false }]);
  // The response remains unresolved while a peer commits local removal.
  await a.evaluate(async () => { await fixture.seed(); await fixture.restore(); fixture.beginRefresh(); }); await b.evaluate(() => fixture.restore());
  await waitFor(() => a.evaluate(() => fixture.state().requests.length === 2), 3000, 'second held response');
  assert.equal(await b.evaluate(() => fixture.remove()), true);
  assert.deepEqual(await b.evaluate(() => fixture.durable()), [{ id: 'unrelated', generation: 'generation-one', pending: false }]);
  await a.evaluate(() => fixture.finishRefresh());
  assert.equal(await a.evaluate(() => fixture.state().refreshOutcome), 'rejected');
  assert.equal(await a.evaluate(() => fixture.sendOld()), false); assert.equal(await a.evaluate(() => fixture.oldIntent()), false);
  assert.equal(await a.evaluate(() => fixture.state().sends), 0);
  // Reusing the route and ID with a new generation cannot authorize the captured old one.
  await a.evaluate(async () => { await fixture.seed(); await fixture.restore(); }); await b.evaluate(() => fixture.restore());
  await b.evaluate(() => fixture.replace());
  assert.equal(await a.evaluate(() => fixture.sendOld()), false); assert.equal(await a.evaluate(() => fixture.oldIntent()), false);
  assert.deepEqual((await b.evaluate(() => fixture.durable())).sort((left, right) => left.id.localeCompare(right.id)), [{ id: 'primary', generation: 'generation-two', pending: false }, { id: 'unrelated', generation: 'generation-one', pending: false }]);
  // Two serialized commits preserve unrelated profiles instead of last-writer replacement.
  await Promise.all([a.evaluate(() => fixture.add('first-extra')), b.evaluate(() => fixture.add('second-extra'))]);
  assert.deepEqual((await a.evaluate(() => fixture.durable())).map(row => row.id).sort(), ['first-extra', 'primary', 'second-extra', 'unrelated']);
  for (const entry of inputs) assert.equal(hash(await readFile(resolve(repoRoot, entry.path))), entry.sha256, `fixture input changed: ${entry.path}`);
  await context.writeArtifactJson('profile-account-http.json', { passed: true, secureContext: false, WebLocksAbsent: true, actualIndexedDB: true, productionProfileCoordinator: true, immutableSecretIndexStore: true, canonicalRotationAcrossRealms: true, remoteResponseOutsideMetadataAuthority: true, removalWhileResponsePending: true, oldGenerationRpcEnqueues: 0, oldGenerationIntentsRejected: true, unrelatedProfilePreserved: true, concurrentCommitsMerged: true, unlinkedLegacyCreationStillBlocked: true, modelRequests: 0, inputSha256: hash(JSON.stringify(inputs)), inputs, bundleSha256: hash(output.outputFiles[0].text), boundary: 'Owned insecure HTTP and production identity modules. Refresh response is a controlled promise; real Gateway and Mobile UI are separate checks.' });
  return { actualIdentityCases: 5, modelRequests: 0 };
});
