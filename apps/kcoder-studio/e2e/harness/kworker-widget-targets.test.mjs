import assert from 'node:assert/strict';
import test from 'node:test';
import { widgetResponseSteps, widgetSettings, widgetSource } from './kworker-widget-targets.mjs';
import { physicalSshArgs, shellQuote } from './physical-widget-ssh.mjs';

test('widget fixture sends complete managed SVG through distinct actual tool argument deltas', () => {
  const steps = widgetResponseSteps({ body: { messages: [{ role: 'user', content: 'protocol fixture' }] } });
  const fragments = steps.flatMap(step => step.delta?.tool_calls ?? []).map(call => call.function.arguments ?? '');
  const input = JSON.parse(fragments.join('')); assert.equal(input.widget_code, widgetSource); assert.equal(input.format, 'svg'); assert.equal(input.execution_mode, undefined);
  assert.equal(steps.at(-1).finishReason, 'tool_calls'); assert.equal(steps[1].ready(), false);
  const terminal = widgetResponseSteps({ body: { messages: [{ role: 'tool', content: 'receipt' }] } }); assert.equal(terminal.at(-1).finishReason, 'stop'); assert.ok(terminal.every(step => !step.delta?.tool_calls));
  const settings = widgetSettings('http://127.0.0.1:123/v1'); assert.equal(settings.providers.fixture.authentication.mode, 'none'); assert.equal(settings.providers.fixture.max_retries, 0);
});
test('physical SSH is explicit, strict, nonmultiplexed and cannot forward account credentials', () => {
  const options = { target: 'owned@10.0.0.1', key: '/credentials/key', knownHosts: '/owned/known_hosts' };
  const args = physicalSshArgs(options, 'python3 fixture'); assert.equal(args.at(-2), options.target); assert.ok(args.includes('StrictHostKeyChecking=yes')); assert.ok(args.includes('ForwardAgent=no')); assert.ok(args.includes('ControlPath=none'));
  assert.throws(() => physicalSshArgs({ ...options, target: 'owned@host; rm -rf x' }), /match/);
  assert.throws(() => physicalSshArgs({ ...options, key: 'relative-key' }));
  assert.equal(shellQuote("a'b $(literal)"), "'a'\\''b $(literal)'");
});

test('remote controller owns and cleans only its private fixture root', { skip: process.platform === 'linux' ? false : 'Physical fixture controller requires Linux /proc' }, async () => {
  const { execFile } = await import('node:child_process');
  const { randomBytes } = await import('node:crypto');
  const { access } = await import('node:fs/promises');
  const { fileURLToPath } = await import('node:url');
  const program = fileURLToPath(new URL('./fixtures/owned-widget-ssh.py', import.meta.url));
  const root = `/tmp/kcoder-widget-e2e-${randomBytes(12).toString('hex')}`;
  const output = await new Promise((resolveOutput, reject) => {
    const child = execFile('python3', [program, root, randomBytes(16).toString('hex')], { timeout: 4000, maxBuffer: 16384 }, (error, stdout) => error ? reject(error) : resolveOutput(stdout));
    child.stdin.end(`${JSON.stringify({ id: 1, action: 'configure', settings: widgetSettings('http://127.0.0.1:1/v1') })}\n${JSON.stringify({ id: 2, action: 'cleanup' })}\n`);
  });
  const frames = output.trim().split('\n').map(line => JSON.parse(line)); assert.equal(frames[0].ready, true); assert.equal(frames.at(-1).result.cleaned, true); await assert.rejects(access(root));
});

test('remote controller rejects a foreign root before any creation or cleanup', { skip: process.platform === 'linux' ? false : 'Physical fixture controller requires Linux /proc' }, async () => {
  const { execFile } = await import('node:child_process'); const { fileURLToPath } = await import('node:url');
  const program = fileURLToPath(new URL('./fixtures/owned-widget-ssh.py', import.meta.url));
  await assert.rejects(new Promise((resolveOutput, reject) => execFile('python3', [program, '/tmp', 'a'.repeat(32)], { timeout: 2000, maxBuffer: 16384 }, error => error ? reject(error) : resolveOutput())), /invalid owned remote root/);
});

test('remote cleanup retains the fixture if its durable owner proof changes', { skip: process.platform === 'linux' ? false : 'Physical fixture controller requires Linux /proc' }, async t => {
  const { execFile } = await import('node:child_process'); const { randomBytes } = await import('node:crypto');
  const { readFile, writeFile, rm, access } = await import('node:fs/promises'); const { fileURLToPath } = await import('node:url'); const { createInterface } = await import('node:readline');
  const program = fileURLToPath(new URL('./fixtures/owned-widget-ssh.py', import.meta.url)); const root = `/tmp/kcoder-widget-e2e-${randomBytes(12).toString('hex')}`;
  t.after(() => rm(root, { recursive: true, force: true }));
  let child;
  const stopped = new Promise(resolveExit => { child = execFile('python3', [program, root, randomBytes(16).toString('hex')], { timeout: 3000, maxBuffer: 16384 }, error => resolveExit(error)); });
  const ready = await new Promise((resolveReady, reject) => { const timer = setTimeout(() => reject(new Error('controller readiness timed out')), 1500); const reader = createInterface({ input: child.stdout }); reader.once('line', line => { clearTimeout(timer); reader.close(); resolveReady(JSON.parse(line)); }); });
  assert.equal(ready.ready, true); const proof = JSON.parse(await readFile(`${root}/owner.json`, 'utf8')); proof.nonce = '0'.repeat(32); await writeFile(`${root}/owner.json`, JSON.stringify(proof)); child.stdin.end(`${JSON.stringify({ id: 1, action: 'cleanup' })}\n`);
  assert.ok(await stopped, 'changed owner must fail instead of deleting the directory'); await access(root);
});
