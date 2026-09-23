import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { waitFor } from './run-context.mjs';

export async function pluginCancellationFixture(context) {
  const source = context.pathInState('cancel-market');
  const packed = context.pathInState('cancel-package');
  await mkdir(resolve(source, '.claude-plugin'), { recursive: true });
  await mkdir(resolve(packed, 'package/.claude-plugin'), { recursive: true });
  await writeFile(resolve(packed, 'package/package.json'), JSON.stringify({ name: 'cancel-demo', version: '1.0.0' }));
  await writeFile(resolve(packed, 'package/.claude-plugin/plugin.json'), JSON.stringify({ name: 'cancel-demo', version: '1.0.0' }));
  const tarball = context.pathInState('cancel-package.tgz');
  const tar = context.spawnOwned('pack-cancel-fixture', 'tar', ['-czf', tarball, '-C', packed, 'package']);
  await waitFor(() => tar.exitCode !== null, 10000, 'pack cancellation fixture');
  assert.equal(tar.exitCode, 0);
  const bytes = await readFile(tarball);
  const integrity = 'sha512-' + createHash('sha512').update(bytes).digest('base64');
  let blocked = true; let requests = 0; let root;
  const server = createServer((req, res) => {
    requests += 1;
    if (blocked) return;
    if (req.url.includes('.tgz')) { res.writeHead(200, { 'content-type': 'application/octet-stream' }); res.end(bytes); return; }
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ name: 'cancel-demo', 'dist-tags': { latest: '1.0.0' }, versions: {
      '1.0.0': { name: 'cancel-demo', version: '1.0.0', dist: { tarball: root + '/package.tgz', integrity } },
    } }));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  root = `http://127.0.0.1:${server.address().port}`;
  context.registerPort('cancel-npm-registry', server.address().port);
  context.addCleanup('close cancellation registry', async () => { const closed = new Promise(resolve => server.close(resolve)); server.closeAllConnections(); await closed; });
  await writeFile(resolve(source, '.claude-plugin/marketplace.json'), JSON.stringify({ name: 'cancel-market', owner: { name: 'Fixture' }, plugins: [{ name: 'cancel-demo', source: { source: 'npm', package: 'cancel-demo', version: '1.0.0', registry: root, integrity } }] }));
  return { source, id: 'cancel-demo@cancel-market', get requests() { return requests; }, unblock() { blocked = false; } };
}
