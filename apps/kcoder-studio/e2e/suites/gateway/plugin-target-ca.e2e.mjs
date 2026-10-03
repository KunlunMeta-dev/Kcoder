import assert from 'node:assert/strict';
import { createServer } from 'node:https';
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { runE2E } from '../../harness/run-context.mjs';
const binary = process.env.KCODER_E2E_PLUGIN_CA_PROBE_BIN;
if (!binary) throw new Error('Explicit isolated plugin_target_ca_probe binary required');
await runE2E(import.meta.url, { testId: 'plugin-download-target-private-ca', tier: 'full-integration',
  modelPolicy: 'local HTTPS smart Git and npm registry, self-owned CA, no external service or model' }, async context => {
  let serial = 0;
  const command = async (name, args, options = {}) => {
    const child = context.spawnOwned(`ca-${++serial}`, name, args, options); const chunks = [], errors = [];
    child.stderr.on('data', chunk => errors.push(chunk));
    child.stdout.on('data', chunk => chunks.push(chunk));
    const code = await new Promise((done, reject) => { child.once('error', reject); child.once('exit', done); });
    return { code, output: Buffer.concat(chunks), error: Buffer.concat(errors).toString() };
  };
  const must = async (name, args, options) => { const result = await command(name, args, options); assert.equal(result.code, 0, `${name} fixture command failed`); return result.output; };
  const certs = context.pathInState('certs'); await mkdir(certs);
  const ca = resolve(certs, 'ca.pem'), caKey = resolve(certs, 'ca.key'), cert = resolve(certs, 'server.pem'), key = resolve(certs, 'server.key');
  await must('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '2', '-subj', '/CN=Owned Plugin Test CA', '-keyout', caKey, '-out', ca]);
  await must('openssl', ['req', '-newkey', 'rsa:2048', '-nodes', '-subj', '/CN=localhost', '-keyout', key, '-out', resolve(certs, 'server.csr')]);
  await writeFile(resolve(certs, 'extensions'), 'subjectAltName=IP:127.0.0.1,DNS:localhost\nextendedKeyUsage=serverAuth\n');
  await must('openssl', ['x509', '-req', '-days', '2', '-in', resolve(certs, 'server.csr'), '-CA', ca, '-CAkey', caKey, '-CAcreateserial', '-extfile', resolve(certs, 'extensions'), '-out', cert]);
  const repo = context.pathInState('repo.git'); await mkdir(resolve(repo, '.claude-plugin'), { recursive: true });
  await mkdir(resolve(repo, 'git-demo/.codex-plugin'), { recursive: true });
  await writeFile(resolve(repo, 'git-demo/.codex-plugin/plugin.json'), JSON.stringify({ name: 'git-demo', version: '1.0.0' }));
  await writeFile(resolve(repo, '.claude-plugin/marketplace.json'), JSON.stringify({ name: 'tls-market', owner: { name: 'fixture' }, plugins: [{ name: 'git-demo', source: './git-demo' }] }));
  await must('git', ['init', repo]); await must('git', ['-C', repo, 'add', '.']);
  await must('git', ['-C', repo, '-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-m', 'fixture']);
  const npmSource = context.pathInState('npm-source'); await mkdir(resolve(npmSource, 'package/.codex-plugin'), { recursive: true });
  await writeFile(resolve(npmSource, 'package/package.json'), JSON.stringify({ name: 'fixture-plugin', version: '1.0.0', scripts: { prepare: 'exit 99' } }));
  await writeFile(resolve(npmSource, 'package/.codex-plugin/plugin.json'), JSON.stringify({ name: 'fixture-plugin', version: '1.0.0' }));
  const tarPath = context.pathInState('fixture.tgz'); await must('tar', ['-czf', tarPath, '-C', npmSource, 'package']);
  const tarball = await readFile(tarPath), integrity = `sha512-${createHash('sha512').update(tarball).digest('base64')}`;
  let origin; const sockets = new Set(); let tlsErrors = 0, gitRequests = 0, npmRequests = 0;
  const server = createServer({ key: await readFile(key), cert: await readFile(cert) }, (request, response) => {
    void (async () => {
      const url = new URL(request.url, origin);
      if (url.pathname.startsWith('/fixture-plugin')) {
        npmRequests++;
        if (url.pathname.endsWith('.tgz')) { response.end(tarball); return; }
        response.setHeader('content-type', 'application/json');
        response.end(JSON.stringify({ name: 'fixture-plugin', 'dist-tags': { latest: '1.0.0' }, versions: { '1.0.0': {
          name: 'fixture-plugin', version: '1.0.0', dist: { integrity, tarball: `${origin}/fixture-plugin/-/fixture-plugin-1.0.0.tgz` },
        } } })); return;
      }
      gitRequests++;
      const body = []; for await (const chunk of request) body.push(chunk);
      const child = context.spawnOwned(`git-http-${++serial}`, 'git', ['http-backend'], { stdin: 'pipe', env: context.isolatedEnvironment({
        GIT_PROJECT_ROOT: context.stateDir, GIT_HTTP_EXPORT_ALL: '1', REQUEST_METHOD: request.method,
        PATH_INFO: decodeURIComponent(url.pathname), QUERY_STRING: url.search.slice(1), CONTENT_TYPE: request.headers['content-type'] || '',
        CONTENT_LENGTH: String(Buffer.concat(body).length),
      }) });
      const output = []; child.stdout.on('data', chunk => output.push(chunk)); child.stdin.end(Buffer.concat(body));
      const code = await new Promise(done => child.once('exit', done)); assert.equal(code, 0);
      const bytes = Buffer.concat(output), split = bytes.indexOf('\r\n\r\n'); assert.ok(split > 0);
      for (const line of bytes.subarray(0, split).toString().split('\r\n')) {
        const colon = line.indexOf(':'); const name = line.slice(0, colon), value = line.slice(colon + 1).trim();
        if (name.toLowerCase() === 'status') response.statusCode = Number(value.split(' ')[0]); else response.setHeader(name, value);
      }
      response.end(bytes.subarray(split + 4));
    })().catch(error => { response.destroy(error); });
  });
  server.on('connection', socket => { sockets.add(socket); socket.once('close', () => sockets.delete(socket)); });
  server.on('tlsClientError', () => tlsErrors++);
  await new Promise(done => server.listen(0, '127.0.0.1', done)); context.registerPort('plugin-tls', server.address().port); origin = `https://127.0.0.1:${server.address().port}`;
  context.addCleanup('close owned plugin TLS endpoint', async () => { const closed = new Promise(done => server.close(done)); for (const socket of sockets) socket.destroy(); await closed; });
  const marketplace = await context.writeStateJson('npm-market/.claude-plugin/marketplace.json', { name: 'tls-npm', owner: { name: 'fixture' }, plugins: [{ name: 'fixture-plugin', source: {
    source: 'npm', package: 'fixture-plugin', version: '1.0.0', registry: origin, integrity,
  } }] });
  const cases = [];
  const run = async (mode, label, caEnvironment = {}, existingRoot) => {
    const root = existingRoot || context.pathInState(label); await mkdir(root, { recursive: true });
    if (!existingRoot) await writeFile(resolve(root, 'settings.json'), JSON.stringify({ plugins: { installation: { timeout_ms: 15000, allow_npm: true } } }), { mode: 0o600 });
    const env = context.isolatedEnvironment({ HOME: root, KCODER_CONFIG_DIR: root, NO_PROXY: '127.0.0.1,localhost',
      GIT_SSL_NO_VERIFY: 'true', NODE_TLS_REJECT_UNAUTHORIZED: '0', npm_config_strict_ssl: 'false',
      GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: 'http.sslVerify', GIT_CONFIG_VALUE_0: 'false', ...caEnvironment });
    const result = await command(binary, [mode, root, mode === 'git' ? `${origin}/repo.git` : marketplace], { cwd: context.stateDir, env });
    cases.push({ mode, label, succeeded: result.code === 0 });
    return { ...result, root };
  };
  const gitNoCa = await run('git', 'git-no-ca');
  assert.notEqual(gitNoCa.code, 0, 'bypass flags must not disable Git verification');
  assert.match(gitNoCa.error, /certificate|ssl/i);
  const git = await run('git', 'git-specific-ca', { GIT_SSL_CAINFO: ca }); assert.equal(git.code, 0, 'target Git CA must be honored');
  const record = JSON.parse(git.output.toString()); assert.equal(record.plugin_id, 'git-demo@tls-market');
  const statePath = resolve(git.root, 'plugin_store/state.json'); const committed = await readFile(statePath);
  const settingsBeforeFailure = await readFile(resolve(git.root, 'settings.json'));
  assert.notEqual((await run('git', 'git-failed-refresh', {}, git.root)).code, 0); assert.deepEqual(await readFile(statePath), committed);
  assert.deepEqual(await readFile(resolve(git.root, 'settings.json')), settingsBeforeFailure);
  assert.equal((await run('git', 'git-generic-relative-ca', { SSL_CERT_FILE: 'certs/ca.pem' })).code, 0, 'relative target CA resolves before private checkout cwd');
  const tlsBeforeNpm = tlsErrors;
  const npmNoCa = await run('npm', 'npm-no-ca');
  assert.notEqual(npmNoCa.code, 0, 'bypass flags must not disable npm verification');
  assert.ok(tlsErrors > tlsBeforeNpm, 'untrusted npm TLS handshake must fail at owned endpoint');
  assert.equal(npmRequests, 0, 'npm bypass flags must not get an HTTP request past TLS');
  const npm = await run('npm', 'npm-ca', { NODE_EXTRA_CA_CERTS: ca }); assert.equal(npm.code, 0, 'target Node CA must reach registry and tarball');
  assert.equal(JSON.parse(npm.output.toString()).source.integrity, integrity);
  assert.equal((await run('npm', 'npm-generic-ca', { SSL_CERT_FILE: ca })).code, 0);
  assert.equal((await run('npm', 'npm-specific-cafile', { npm_config_cafile: ca })).code, 0);
  assert.ok(tlsErrors > 0 && gitRequests > 0 && npmRequests > 0);
  await context.writeArtifactJson('ca-results.json', { cases, tlsErrors, gitRequests, npmRequests, source: record.source, failedRefreshPreservedInstalledState: true, integrity });
  return { cases, failedRefreshPreservedInstalledState: true, verifiedGitAndNpm: true };
});
