import assert from 'node:assert/strict';
import test from 'node:test';
import { createServer } from 'node:http';
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { writeManifest } from './artifact-manifest.mjs';
import { createDelivery, resumeDelivery, fileIdentity, recoverLock } from './delivery-journal.mjs';

// Real loopback uploads and local delivery, with owned temporary files. These
// prove coordination/retry invariants, not a public Release or installed app.
async function fixture(t) {
  const root = await mkdtemp(resolve(tmpdir(), 'kcoder-delivery-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const resources = resolve(root, 'resources'), artifact = resolve(root, 'KCoder-Studio-Setup-0.3.4-win-x64.exe');
  await mkdir(resolve(resources, 'bin'), { recursive: true });
  await writeFile(resolve(resources, 'bin/kcoder.exe'), 'owned CLI fixture');
  await writeFile(artifact, 'one frozen installer fixture');
  const sourceCommit = 'a'.repeat(40), publishedCommit = 'b'.repeat(40);
  const manifest = await writeManifest(resources, { kind: 'fixture', platform: 'win32',
    identity: { versions: { cli: '0.1.0', studio: '0.3.4', mobile: '0.1.0' },
      protocol: { version: '2026-07-27', sourceDeclaredCapabilities: ['threadResume'] },
      packagingSource: { commit: sourceCommit, dirty: false } } });
  const counts = {}, stored = {}, old = 'KCoder-Studio-Setup-0.3.3-win-x64.exe';
  const server = createServer(async (request, response) => {
    const [target, phase] = request.url.slice(1).split('/');
    const key = target + '/' + phase;
    response.setHeader('Content-Type', 'application/json');
    if (target === 'gitee') { response.statusCode = 403; response.end(JSON.stringify({ status: 'blocked', code: 'permission_denied' })); return; }
    if (request.method === 'GET') {
      if (phase === 'push') response.end(JSON.stringify({ status: 'verified', remoteCommit: publishedCommit }));
      else response.end(JSON.stringify(stored[key] ?? { status: 'absent' }));
      return;
    }
    counts[key] = (counts[key] ?? 0) + 1;
    if (target === 'github-two' && counts[key] === 1 && phase === 'upload') { response.statusCode = 500; response.end('{}'); request.resume(); return; }
    if (phase === 'upload') {
      const chunks = []; for await (const chunk of request) chunks.push(chunk);
      assert.deepEqual(Buffer.concat(chunks), await readFile(artifact));
      stored[key] = { status: 'verified', ...await fileIdentity(artifact) };
    } else if (phase === 'cleanup') {
      assert.equal(stored[target + '/upload']?.status, 'verified');
      stored[key] = { status: 'verified', keptName: (await fileIdentity(artifact)).name,
        keptSha256: (await fileIdentity(artifact)).sha256, removedNames: [old] };
    }
    response.end('{}');
  });
  await new Promise(done => server.listen(0, '127.0.0.1', done));
  t.after(() => new Promise(done => server.close(done)));
  const base = `http://127.0.0.1:${server.address().port}`;
  const cli = manifest.resources.find(item => item.path === 'bin/kcoder.exe');
  const runtime = { status: 'verified', ...(await fileIdentity(artifact)), cliSha256: cli.sha256,
    buildCommit: sourceCommit, buildDirty: false, cliVersion: '0.1.0', studioVersion: '0.3.4', protocolVersion: manifest.protocol.version, capabilities: ['threadResume'] };
  const adapter = resolve(root, 'adapter.mjs');
  await writeFile(adapter, `import { readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
const mode=process.argv[2];
if(mode==='runtime'){ console.log(JSON.stringify(${JSON.stringify(runtime)})); }
else if(mode==='host'){
 const path=${JSON.stringify(resolve(root, 'download.exe'))};
 if(process.argv[3]==='execute') await writeFile(path, await readFile(process.env.KCODER_DELIVERY_ARTIFACT));
 let result={status:'absent',activeTasks:0,desktopInUse:false};
 try{const bytes=await readFile(path);result={status:'verified',name:${JSON.stringify(runtime.name)},bytes:bytes.length,sha256:createHash('sha256').update(bytes).digest('hex')};}catch{}
 console.log(JSON.stringify(result));
} else {
 const url=${JSON.stringify(base)}+'/'+process.env.KCODER_DELIVERY_TARGET+'/'+process.env.KCODER_DELIVERY_PHASE;
 const response=await fetch(url,mode==='execute'?{method:'POST',body:await readFile(process.env.KCODER_DELIVERY_ARTIFACT)}:{});
 console.log(await response.text());
}`);
  const adapters = Object.fromEntries(['push', 'upload', 'cleanup'].map(phase => [phase,
    { execute: [process.execPath, adapter, 'execute'], verify: [process.execPath, adapter, 'verify'], timeoutMs: 3000 }]));
  const plan = { schemaVersion: 1, artifact, resourceRoot: resources, sourceCommit,
    runtimeVerify: [process.execPath, adapter, 'runtime'], targets: [
      ...['github-one', 'github-two', 'gitee'].map(id => ({ id, kind: 'repository', publishedCommit, adapters })),
      { id: 'windows', kind: 'host', allowInstall: false, adapters: { deliver: { execute: [process.execPath, adapter, 'host', 'execute'], verify: [process.execPath, adapter, 'host', 'verify'] } } },
    ] };
  const planPath = resolve(root, 'plan.json'), journalPath = resolve(root, 'journal.json');
  await writeFile(planPath, JSON.stringify(plan));
  return { root, artifact, plan, planPath, journalPath, counts, stored, adapter };
}
test('one artifact survives failed upload and 403 while successful targets are not repeated', async t => {
  const f = await fixture(t); const created = await createDelivery(f.planPath, f.journalPath);
  assert.equal(created.checks.runtime.negotiatedCapabilities[0], 'threadResume');
  const first = await resumeDelivery(f.planPath, f.journalPath, { execute: true });
  assert.equal(first.targets['github-one'].stages.cleanup.status, 'verified');
  assert.equal(first.targets['github-two'].stages.upload.status, 'failed');
  assert.equal(first.targets['github-two'].stages.cleanup.attempts, 0);
  assert.equal(first.targets.gitee.stages.push.status, 'blocked');
  assert.equal(first.targets.gitee.stages.push.code, 'permission_denied');
  assert.equal(first.targets.windows.stages.deliver.status, 'verified');
  assert.equal(first.targets.windows.stages.install.status, 'pending');
  const second = await resumeDelivery(f.planPath, f.journalPath, { execute: true });
  assert.equal(second.targets['github-two'].stages.cleanup.status, 'verified');
  assert.equal(second.targets.gitee.stages.push.status, 'blocked');
  assert.equal(f.counts['github-one/upload'], 1); assert.equal(f.counts['github-two/upload'], 2);
  assert.equal(f.counts['github-one/cleanup'], 1); assert.equal(f.counts['github-two/cleanup'], 1);
  assert.deepEqual(second.artifact, created.artifact);
  assert.equal(f.counts['gitee/upload'], undefined);
  // A remote write can complete before the local coordinator records its
  // receipt. Resume observes those actual bytes rather than re-uploading.
  second.targets['github-one'].stages.upload.status = 'in_flight';
  await writeFile(f.journalPath, JSON.stringify(second));
  const recovered = await resumeDelivery(f.planPath, f.journalPath, { targetId: 'github-one', phase: 'upload', execute: true });
  assert.equal(recovered.targets['github-one'].stages.upload.status, 'verified');
  assert.equal(f.counts['github-one/upload'], 1);
  const text = await readFile(f.journalPath, 'utf8');
  assert.ok(!text.includes('adapter.mjs') && !text.includes('http://'));
});
test('unknown receipt is observed without blindly resending and changed bytes cannot resume', async t => {
  const f = await fixture(t); await createDelivery(f.planPath, f.journalPath);
  f.plan.targets[0].adapters.upload.verify = [process.execPath, '-e', 'console.log(JSON.stringify({status:"unknown",unsafe:"credential-content"}))'];
  await writeFile(f.planPath, JSON.stringify(f.plan));
  const observed = await resumeDelivery(f.planPath, f.journalPath, { targetId: 'github-one', execute: true });
  assert.equal(observed.targets['github-one'].stages.upload.status, 'unknown');
  assert.equal(f.counts['github-one/upload'], undefined);
  assert.ok(!(await readFile(f.journalPath, 'utf8')).includes('credential-content'));
  await writeFile(f.artifact, 'changed');
  await assert.rejects(resumeDelivery(f.planPath, f.journalPath, { execute: true }), /Frozen installer changed/);
});
test('live coordinator lock cannot be stolen and non-Windows release attachments are refused', async t => {
  const f = await fixture(t); await createDelivery(f.planPath, f.journalPath);
  await mkdir(f.journalPath + '.lock');
  const { hostname } = await import('node:os');
  await writeFile(resolve(f.journalPath + '.lock', 'owner.json'), JSON.stringify({ pid: process.pid, host: hostname(), nonce: 'owned' }));
  await assert.rejects(recoverLock(f.journalPath), /still alive/);
  await assert.rejects(resumeDelivery(f.planPath, f.journalPath), /locked/);
  await rm(f.journalPath + '.lock', { recursive: true });
  f.plan.artifact = resolve(f.root, 'other.zip'); await writeFile(f.plan.artifact, 'not a Windows installer');
  await writeFile(f.planPath, JSON.stringify(f.plan));
  await assert.rejects(createDelivery(f.planPath, resolve(f.root, 'wrong.json')), /only the matching Windows installer/);
});
