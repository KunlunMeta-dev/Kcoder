// Owned Node parent for the real storage CLI handoff integration.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { closeSync, openSync, readFileSync, statSync } from 'node:fs';
import { setTimeout as delay } from 'node:timers/promises';
import { acquireStorageInstance, loadStorageNative } from '../src/storage-lease.mjs';
import { loadStorageContext } from '../src/storage-paths.mjs';

const [cli, configPath, stdoutPath, stderrPath] = process.argv.slice(2);
const ENTRY = '--internal-storage-operation-v1';
assert.ok(cli?.startsWith('/'), 'storage CLI must be an absolute owned executable');
assert.ok(configPath?.startsWith('/') && stdoutPath?.startsWith('/') && stderrPath?.startsWith('/'));

function processIdentity(pid) {
  const text = readFileSync(`/proc/${pid}/stat`, 'utf8');
  const fields = text.slice(text.lastIndexOf(')') + 2).trim().split(/\s+/);
  return { pid, state: fields[0], parent: Number(fields[1]), group: Number(fields[2]),
    session: Number(fields[3]), started: fields[19], uid: statSync(`/proc/${pid}`).uid };
}

function send(frame) {
  return new Promise((resolve, reject) => {
    process.stdout.write(`${JSON.stringify(frame)}\n`, error => error ? reject(error) : resolve());
  });
}

const config = JSON.parse(readFileSync(configPath, 'utf8'));
assert.ok(config && typeof config === 'object' && ['handoff', 'retry-handoff'].includes(config.mode));
assert.ok(typeof config.home === 'string' && config.home.startsWith('/'));
assert.ok(config.inputText === null || typeof config.inputText === 'string');
const native = await loadStorageNative();
const selected = await loadStorageContext({ home: config.home, env: process.env, consumer: 'desktop' });
const lease = await acquireStorageInstance(selected, { native });
lease.verify();

const stdoutFd = openSync(stdoutPath, 'wx', 0o600);
const stderrFd = openSync(stderrPath, 'wx', 0o600);
const child = spawn(cli, [ENTRY, config.mode], { cwd: config.home, env: process.env, shell: false,
  stdio: ['pipe', stdoutFd, stderrFd] });
closeSync(stdoutFd);
closeSync(stderrFd);
assert.ok(Number.isSafeInteger(child.pid) && child.pid > 1, 'storage CLI child must have an OS PID');
const actorIdentity = processIdentity(process.pid);
const cliIdentity = processIdentity(child.pid);
const cliArgs = readFileSync(`/proc/${child.pid}/cmdline`, 'utf8').split('\0').filter(Boolean);
assert.deepEqual(cliArgs, [cli, ENTRY, config.mode], 'the owned actor must launch the requested handoff mode directly');
assert.equal(cliIdentity.parent, actorIdentity.pid, 'the Node actor must be the actual CLI OS parent');
assert.equal(cliIdentity.group, actorIdentity.group);
assert.equal(cliIdentity.session, actorIdentity.session);
await send({ kind: 'spawned', mode: config.mode, cliArgs, actor: actorIdentity, cli: cliIdentity });

if (config.inputText === null) child.stdin.end();
else child.stdin.end(config.inputText);

let readyForwarded = false;
let firstFrameSettled = false;
const observeFirstFrame = async () => {
  while (!firstFrameSettled) {
    let output = '';
    try {
      assert.ok(statSync(stdoutPath).size <= 1024 * 1024, 'storage CLI handoff stdout exceeded its output budget');
      output = readFileSync(stdoutPath, 'utf8');
    }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    const newline = output.indexOf('\n');
    if (newline >= 0) {
      const line = output.slice(0, newline);
      const frame = JSON.parse(line);
      firstFrameSettled = true;
      if (frame?.state === 'ready' && frame.operationId === config.operationId &&
        Object.keys(frame).every(key => ['operationId', 'state'].includes(key))) {
        readyForwarded = true;
        await send({ kind: 'ready', frame });
      } else {
        await send({ kind: 'unexpected-first-frame', frame });
      }
      return;
    }
    if (child.exitCode !== null || child.signalCode !== null) {
      firstFrameSettled = true;
      await send({ kind: 'cli-exited-before-ready', exitCode: child.exitCode, signal: child.signalCode });
      return;
    }
    await delay(10);
  }
};
void observeFirstFrame().catch(async () => {
  firstFrameSettled = true;
  await send({ kind: 'actor-observation-failed' }).catch(() => {});
});

child.once('close', (exitCode, signal) => {
  void send({ kind: 'cli-closed', exitCode, signal, readyForwarded }).catch(() => {});
});

let commandBuffer = '';
let commandBusy = false;
process.stdin.setEncoding('utf8');
process.stdin.on('data', chunk => {
  commandBuffer += chunk;
  for (;;) {
    const newline = commandBuffer.indexOf('\n');
    if (newline < 0) break;
    const line = commandBuffer.slice(0, newline);
    commandBuffer = commandBuffer.slice(newline + 1);
    if (!line) continue;
    if (commandBusy) { void send({ kind: 'actor-command-busy' }); continue; }
    commandBusy = true;
    void (async () => {
      const command = JSON.parse(line);
      if (command.command === 'closeLease') {
        lease.close();
        await send({ kind: 'lease-closed' });
      } else if (command.command === 'exit') {
        await send({ kind: 'parent-exiting' });
        process.exit(0);
      } else {
        await send({ kind: 'unknown-command' });
      }
    })().finally(() => { commandBusy = false; });
  }
});
