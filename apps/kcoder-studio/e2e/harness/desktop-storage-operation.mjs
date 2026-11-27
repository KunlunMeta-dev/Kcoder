import assert from 'node:assert/strict';
import { readFile, readdir, stat } from 'node:fs/promises';
import { signalProcessTree } from './owned-process.mjs';
import { waitFor } from './run-context.mjs';
import { openRpc } from './rpc.mjs';

/** The existing storage CLI entry, with this RunContext retaining process ownership. */
export function startStorageCliProbe(context, { label, cli, args, home, env, input, keepInput = false }) {
  const child = context.spawnOwned(label, cli, args, { cwd: home, env, stdin: 'pipe' });
  let stdout = '', stderr = '', closed = false, overflow = false;
  const collect = key => bytes => {
    if (key === 'stdout') stdout += bytes;
    else stderr += bytes;
    overflow ||= Buffer.byteLength(stdout) + Buffer.byteLength(stderr) > 1024 * 1024;
    stdout = stdout.slice(0, 1024 * 1024); stderr = stderr.slice(0, 1024 * 1024);
  };
  child.stdout.on('data', collect('stdout')); child.stderr.on('data', collect('stderr'));
  child.stdin.on('error', () => {});
  child.once('close', () => { closed = true; });
  if (!keepInput) child.stdin.end(input === undefined ? undefined : JSON.stringify(input));
  return { child, output: () => stdout, diagnostic: () => stderr,
    first: () => {
      assert.equal(overflow, false, 'storage probe exceeded its bounded protocol output');
      const newline = stdout.indexOf('\n');
      return newline < 0 ? null : JSON.parse(stdout.slice(0, newline));
    },
    finish: async (timeoutMs = 15000) => {
      await waitFor(() => closed, timeoutMs, `storage CLI ${label} exits`, 25, context.abortSignal);
      assert.equal(overflow, false, 'storage probe exceeded its bounded protocol output');
      return { exitCode: child.exitCode, signal: child.signalCode, stdout, stderr };
    },
  };
}

/** Hold only the actual readonly verifier spawned by this owned operation. */
export async function pauseStorageVerifier(context, { parent, cli, home, operationId }) {
  const original = storageProcessStat(parent.pid, await readFile(`/proc/${parent.pid}/stat`, 'utf8'));
  return waitFor(async () => {
    if (parent.isRunning?.() === false || parent.exitCode !== null || parent.signalCode !== null) {
      throw new Error('STORAGE_PROBE_PARENT_EXITED_BEFORE_VERIFIER');
    }
    const pids = (await readFile(`/proc/${parent.pid}/task/${parent.pid}/children`, 'utf8')).trim().split(/\s+/).filter(Boolean);
    for (const value of pids) {
      const pid = Number(value), root = `/proc/${pid}`;
      try {
        const args = (await readFile(`${root}/cmdline`, 'utf8')).split('\0').filter(Boolean);
        if (args.length !== 4 || args[0] !== cli || args[1] !== '--internal-storage-operation-v1' ||
            args[2] !== 'verify' || args[3] !== operationId) continue;
        const identity = storageProcessStat(pid, await readFile(`${root}/stat`, 'utf8'));
        assert.equal(identity.parent, parent.pid); assert.equal(identity.group, original.group);
        assert.equal(identity.session, original.session); assert.equal((await stat(root)).uid, process.getuid());
        const environment = (await readFile(`${root}/environ`, 'utf8')).split('\0');
        assert.ok(environment.includes(`HOME=${home}`), 'never stop a verifier outside the owned Home');
        const current = async () => {
          try {
            const observed = storageProcessStat(pid, await readFile(`${root}/stat`, 'utf8'));
            return observed.started === identity.started && observed.group === identity.group && observed.state !== 'Z' ? observed : null;
          } catch (error) { if (['ENOENT', 'ESRCH'].includes(error.code)) return null; throw error; }
        };
        const resume = async () => { if (await current()) process.kill(pid, 'SIGCONT'); };
        context.addCleanup(`continue only original held verifier ${operationId}`, resume);
        if (!await current()) continue;
        process.kill(pid, 'SIGSTOP');
        await waitFor(async () => (await current())?.state === 'T', 1000, 'original verifier is held', 1, context.abortSignal);
        return { identity, resume, current };
      } catch (error) { if (['ENOENT', 'ESRCH'].includes(error.code)) continue; throw error; }
    }
    return null;
  }, 10000, 'actual original readonly verifier child', 1, context.abortSignal);
}

/** Native input and passive main-process observation for the owned storage host. */
export async function desktopStorageObservation(context, { desktop, display, xdotool, label }) {
  const url = await waitFor(() => desktop.output().match(/Debugger listening on (ws:\/\/127\.0\.0\.1:[^\s]+)/)?.[1],
    10_000, 'owned storage main inspector', 100, context.abortSignal);
  const inspector = await openRpc(url);
  context.registerPort(`${label}-inspector`, Number(new URL(url).port));
  context.addCleanup(`close ${label} inspector`, () => inspector.close());
  let sequence = 0;
  return {
    close: () => inspector.close(),
    evaluateMain: async expression => {
      const id = ++sequence;
      inspector.socket.send(JSON.stringify({ id, method: 'Runtime.evaluate', params: { expression, returnByValue: true } }));
      const response = await inspector.waitFor(value => value.id === id, 5000, 'owned storage main observation');
      assert.equal(response.error, undefined);
      assert.equal(response.result?.exceptionDetails, undefined);
      return response.result.result.value;
    },
    nativeInput: createStorageNativeInput(context, { display, xdotool, label }),
  };
}

/** First-launch dialogs precede CDP readiness and use this same owned native input. */
export function createStorageNativeInput(context, { display, xdotool, label }) {
  const env = context.isolatedEnvironment({ DISPLAY: display.display, XAUTHORITY: display.authority });
  let sequence = 0;
  return async args => {
    const cleaning = context.finishing === true;
    const spawn = cleaning ? context.spawnCleanupOwned.bind(context) : context.spawnOwned.bind(context);
    const child = spawn(`${label}-input-${++sequence}`, xdotool, args, { env });
    let output = '', hasDiagnostic = false, closed = false;
    child.stdout.on('data', chunk => { output += chunk; });
    child.stderr.on('data', chunk => { if (chunk.toString().trim()) hasDiagnostic = true; });
    child.once('close', () => { closed = true; });
    await waitFor(() => closed, 10_000, 'owned storage native input', 50, cleaning ? undefined : context.abortSignal);
    if (child.exitCode !== 0) {
      const error = new assert.AssertionError({ actual: child.exitCode, expected: 0, operator: 'strictEqual' });
      error.nativeWindowNotFound = args[0] === 'search' && child.exitCode === 1 && !hasDiagnostic;
      throw error;
    }
    return output.trim();
  };
}

/** GTK may set a mapped dialog's title after xdotool's synchronous event wait. */
export async function waitForStorageNativeWindow(nativeInput, pattern, signal) {
  return waitFor(async () => {
    try { return await nativeInput(['search', '--onlyvisible', '--name', pattern]); }
    catch (error) {
      if (error.nativeWindowNotFound === true) return null;
      throw error;
    }
  }, 10_000, 'owned storage native window', 150, signal);
}

async function requestStorageWindowQuit(nativeInput, pid) {
  const ids = await nativeInput(['search', '--onlyvisible', '--pid', String(pid)]).catch(error => {
    if (error.nativeWindowNotFound === true) return '';
    throw error;
  });
  for (const id of ids.split(/\s+/).filter(Boolean)) {
    if (!/KCoder Studio/.test(await nativeInput(['getwindowname', id]))) continue;
    await nativeInput(['windowfocus', '--sync', id]);
    await nativeInput(['key', '--clearmodifiers', 'ctrl+q']);
    return true;
  }
  return false;
}

/** Close a ready source host through its actual Quit command before a cold read. */
export async function quitStorageDesktop(context, { desktop, observation, home, label }, {
  read = readFile, members = storageProcessGroupMembers, wait = waitFor,
} = {}) {
  const identity = storageProcessStat(desktop.child.pid, await read(`/proc/${desktop.child.pid}/stat`, 'utf8'));
  const before = await members(identity.group);
  assertStorageGroupObserved(identity, before, process.getuid());
  assert.ok(before.some(member => member.pid === identity.pid), 'the original main process must still be present before Quit');
  // Ctrl+Q addresses only this main window. A utility child's missing HOME is
  // passive observation, never authority to signal that child or its group.
  assertStorageGroupOwned(identity, before.filter(member => member.pid === identity.pid || member.home !== undefined), home, process.getuid());
  assert.ok(await requestStorageWindowQuit(observation.nativeInput, identity.pid),
    'the ready owned Electron main window must receive Quit');
  observation.close();
  await wait(async () => desktop.child.exitCode !== null && !(await members(identity.group, { includeHome: false })).length,
    30_000, `${label} real Quit and complete process-group exit`, 100, context.abortSignal);
  assert.equal(desktop.child.exitCode, 0);
  assert.equal(desktop.child.signalCode, null, 'a forced signal does not prove a normal cold shutdown');
  await desktop.stop();
  return { identity, before, remaining: 0, exitCode: desktop.child.exitCode, signal: desktop.child.signalCode };
}

export function storageProcessStat(pid, text) {
  const fields = text.slice(text.lastIndexOf(')') + 2).trim().split(/\s+/);
  return { pid, state: fields[0], parent: Number(fields[1]), group: Number(fields[2]),
    session: Number(fields[3]), started: fields[19] };
}

// Read-only observation remains valid while an exiting process loses its environment.
// It grants no right to signal a group. Cleanup additionally requires the owned HOME.
export function assertStorageGroupObserved(receipt, members, uid) {
  assert.ok(Number.isSafeInteger(receipt.pid) && receipt.pid > 1);
  assert.equal(receipt.group, receipt.pid, 'handoff must own its detached process group');
  assert.equal(receipt.session, receipt.pid);
  assert.match(receipt.started, /^\d+$/);
  for (const member of members) {
    assert.equal(member.group, receipt.group);
    assert.equal(member.session, receipt.session);
    assert.equal(member.uid, uid);
    assert.ok(BigInt(member.started) >= BigInt(receipt.started));
    if (member.pid === receipt.pid) assert.equal(member.started, receipt.started);
  }
}

export function assertStorageGroupOwned(receipt, members, home, uid) {
  assertStorageGroupObserved(receipt, members, uid);
  for (const member of members) {
    assert.equal(member.home, home, 'never signal a peer or unconfirmed storage process');
  }
}

export async function storageProcessGroupMembers(group, { includeHome = true } = {}) {
  const members = [];
  for (const entry of await readdir('/proc', { withFileTypes: true })) {
    if (!/^\d+$/.test(entry.name)) continue;
    try {
      const path = `/proc/${entry.name}`;
      const identity = storageProcessStat(Number(entry.name), await readFile(`${path}/stat`, 'utf8'));
      if (identity.group !== group || identity.state === 'Z') continue;
      let home;
      if (includeHome) {
        const environment = await readFile(`${path}/environ`);
        assert.ok(environment.length <= 1024 * 1024, 'owned process environment exceeds probe budget');
        home = environment.toString().split('\0').find(value => value.startsWith('HOME='))?.slice(5);
      }
      const uid = (await stat(path)).uid;
      const confirmed = storageProcessStat(Number(entry.name), await readFile(`${path}/stat`, 'utf8'));
      if (confirmed.state === 'Z' || identity.started !== confirmed.started
        || identity.group !== confirmed.group || identity.session !== confirmed.session) continue;
      members.push({ ...confirmed, uid, ...(includeHome ? { home } : {}) });
    } catch (error) {
      if (!['ENOENT', 'ESRCH'].includes(error.code)) throw error;
    }
  }
  return members;
}

// Observe the actual host spawn without changing its arguments, environment,
// pipes, readiness or result. The test owner outlives the original Electron.
function installSpawnObserver(receiptPath, cli, home) {
  const fs = process.getBuiltinModule('fs');
  const prototype = process.getBuiltinModule('child_process').ChildProcess.prototype;
  const original = prototype.spawn;
  prototype.spawn = function(options) {
    const result = original.call(this, options);
    if (options.file === cli && options.args[1] === '--internal-storage-operation-v1' && options.args[2] === 'plan') {
      const codes = new Set();
      const domains = new Set();
      let diagnostic = '', output = '';
      this.stdout?.on('data', bytes => { output = (output + bytes).slice(0, 65536); });
      this.stderr?.on('data', bytes => {
        const text = bytes.toString();
        // This owned fixture has no providers or user credentials. Retain only
        // a bounded error shape, never paths, URLs or opaque identity/token data.
        diagnostic = (diagnostic + text.replace(/(?:https?:\/\/|[A-Za-z]:[\\/]|\/)[^\s"']+/g, '<path>')
          .replace(/[A-Za-z0-9_-]{24,}/g, '<redacted>')).slice(0, 8192);
        for (const code of text.match(/(?:STORAGE|INTEGRATION|NATIVE_DOMAIN|PROFILE_IDENTITY|SERVICE_LEASE|APP_SERVER_HOST|NATIVE_CODE)_[A-Z0-9_]+/g) ?? []) {
          if (codes.size < 16) codes.add(code);
        }
        for (const match of text.matchAll(/STORAGE_NATIVE_DOMAIN_OWNER_UNSUPPORTED: ([A-Za-z0-9_]+)/g)) domains.add(match[1]);
      });
      this.once('close', code => {
        if (code) fs.writeFileSync(`${receiptPath}.plan-error`, JSON.stringify({ exitCode: code, codes: [...codes], domains: [...domains], diagnostic }), { mode: 0o600 });
        else {
          try {
            const id = JSON.parse(output).operationId;
            if (/^[a-f\d]{8}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{12}$/i.test(id))
              fs.writeFileSync(`${receiptPath}.plan-id`, JSON.stringify(id), { mode: 0o600 });
          } catch { /* A missing original plan identity cannot be substituted. */ }
        }
      });
    }
    if (options.file === cli && options.args[1] === '--internal-storage-operation-v1' && options.args[2] === 'handoff') {
      try {
        if (!options.detached || !options.envPairs.includes(`HOME=${home}`)) throw new Error('unconfirmed host child');
        const fields = fs.readFileSync(`/proc/${this.pid}/stat`, 'utf8').split(') ').at(-1).trim().split(/\s+/);
        fs.writeFileSync(receiptPath, JSON.stringify({ pid: this.pid, parent: Number(fields[1]),
          group: Number(fields[2]), session: Number(fields[3]), started: fields[19] }), { flag: 'wx', mode: 0o600 });
      } catch {
        if (!fs.existsSync(receiptPath)) fs.writeFileSync(receiptPath, '{"unconfirmed":true}', { flag: 'wx', mode: 0o600 });
      }
    }
    return result;
  };
  return true;
}

export async function observeDesktopStorageHandoff(context, { evaluateMain, nativeInput, cli, home, hostPid, label = 'storage-handoff' }, {
  read = readFile, groupMembers = storageProcessGroupMembers, signal = signalProcessTree, wait = waitFor,
} = {}) {
  assert.equal(process.platform, 'linux', 'this native observation requires Linux /proc');
  assert.match(label, /^[a-z0-9-]{1,64}$/);
  const path = context.pathInState(`${label}-process.json`);
  const original = storageProcessStat(hostPid, await read(`/proc/${hostPid}/stat`, 'utf8'));
  assertStorageGroupOwned(original, [], home, process.getuid());
  const sourceMembers = async () => {
    const members = await groupMembers(original.group);
    assertStorageGroupObserved(original, members, process.getuid());
    return members;
  };
  const receipt = async () => {
    const value = JSON.parse(await read(path, 'utf8'));
    assert.equal(value.parent, hostPid);
    assertStorageGroupOwned(value, [], home, process.getuid());
    return value;
  };
  let quitAttempted = false;
  const stop = async () => {
    let captured;
    try { captured = await receipt(); }
    catch (error) { if (error.code === 'ENOENT') return; throw error; }
    const inspectOwned = async () => {
      const members = await groupMembers(captured.group);
      assertStorageGroupOwned(captured, members, home, process.getuid());
      return members;
    };
    const observed = await groupMembers(captured.group);
    assertStorageGroupObserved(captured, observed, process.getuid());
    if (!observed.length) return;
    if (nativeInput && !quitAttempted) {
      quitAttempted = true;
      try {
        assertStorageGroupOwned(captured, observed.filter(member => member.home !== undefined), home, process.getuid());
        for (const member of observed.filter(member => member.home === home)) {
          if (!await requestStorageWindowQuit(nativeInput, member.pid)) continue;
          await wait(async () => {
            const members = await groupMembers(captured.group, { includeHome: false });
            assertStorageGroupObserved(captured, members, process.getuid());
            return members.length === 0;
          }, 5_000, 'owned restarted desktop exits through its real Quit command', 100);
          return;
        }
      } catch { /* Unconfirmed window exit never relaxes the original signal checks. */ }
    }
    if (!(await inspectOwned()).length) return;
    await signal(null, { pid: captured.pid, pgid: captured.group }, 'SIGTERM');
    await wait(async () => {
      const members = await groupMembers(captured.group, { includeHome: false });
      assertStorageGroupObserved(captured, members, process.getuid());
      return members.length === 0;
    }, 15_000, 'owned restarted desktop graceful exit', 100);
  };
  context.addCleanup('stop this operation and restarted desktop by verified owned process group', stop, { timeoutMs: 40_000 });
  assert.equal(await evaluateMain(`(${installSpawnObserver})(${JSON.stringify(path)},${JSON.stringify(cli)},${JSON.stringify(home)})`), true);
  return { stop, receipt, sourceMembers, planId: async () => {
    try { return JSON.parse(await readFile(`${path}.plan-id`, 'utf8')); }
    catch (error) { if (error.code === 'ENOENT') return null; throw error; }
  }, planFailure: async () => {
    try { return JSON.parse(await readFile(`${path}.plan-error`, 'utf8')); }
    catch (error) { if (error.code === 'ENOENT') return null; throw error; }
  }, members: async () => {
    const captured = await receipt();
    const members = await groupMembers(captured.group);
    assertStorageGroupObserved(captured, members, process.getuid());
    return members;
  } };
}
