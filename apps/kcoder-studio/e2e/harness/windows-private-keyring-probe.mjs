import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { waitForStdioChildClose } from './app-server-stdio.mjs';
import { keyringJson } from './windows-private-keyring-state.mjs';
import { runPrivateKeyringWrite } from './windows-private-keyring-write.mjs';
import { runPrivateKeyringReopen } from './windows-private-keyring-reopen.mjs';
import { validatePrivateFixture } from './windows-private-credential-review.mjs';

export async function runPrivateKeyringPhase({ phase, root, owner, expectedRoot, handoff }) {
  assert.equal(process.platform, 'win32'); assert.ok(['write', 'reopen', 'cleanup'].includes(phase));
  assert.equal(basename(root), 'kcoder-package-' + owner);
  const runtime = await keyringJson(join(handoff, 'host-runtime.json'));
  assert.equal(runtime.owner, owner); assert.equal(runtime.version, 2); assert.equal(runtime.scenario, 'private-rpc');
  assert.equal(new Set(runtime.sources.map(row => row.leaf)).size, runtime.sources.length);
  for (const row of runtime.sources) {
    assert.match(row.leaf, /^[a-z0-9.-]+\.(?:mjs|exe)$/); assert.match(row.sha256, /^[a-f0-9]{64}$/);
    assert.equal(createHash('sha256').update(await readFile(join(handoff, row.leaf))).digest('hex'), row.sha256);
  }
  assert.equal(createHash('sha256').update(await readFile(process.execPath)).digest('hex'), runtime.nodeSha256);
  const audit = async mode => {
    assert.ok(['--vault-root', '--private-admit', '--private-bind', '--private-capture', '--private-final', '--private-unused-final'].includes(mode));
    // The original normal-logon C# Job contains this read-only helper and the Native descendants.
    const child = spawn(join(handoff, 'security-helper.exe'), [mode, root, owner, ...(mode === '--vault-root' ? [] : [expectedRoot])],
      { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let output = '', bytes = 0;
    child.stdout.on('data', data => { bytes += data.length; if (bytes <= 65536) output += data.toString('utf8'); });
    child.stderr.resume(); await waitForStdioChildClose(child, 15000, 'private keyring read-only auditor');
    assert.ok(bytes <= 65536 && child.exitCode === 0, 'private_keyring_audit_failed');
    return JSON.parse(output);
  };
  assert.equal((await audit('--vault-root')).rootIdentity, expectedRoot);
  if (phase === 'write') {
    const supplied = await keyringJson(join(handoff, 'private-keyring-source.json'), 4096);
    validatePrivateFixture(supplied, owner);
    await writeFile(join(root, 'private-fixture.json'), JSON.stringify(supplied), { flag: 'wx' });
  }
  const environment = Object.fromEntries(['SystemRoot', 'WINDIR', 'COMSPEC', 'PATHEXT', 'PATH', 'SystemDrive']
    .filter(name => process.env[name]).map(name => [name, process.env[name]]));
  Object.assign(environment, { TEMP: root, TMP: root, NO_COLOR: '1' });
  const options = { root, binary: join(handoff, 'host-cli.exe'), environment, owner, audit };
  const result = await (phase === 'write' ? runPrivateKeyringWrite(options) : runPrivateKeyringReopen({ ...options, cleanup: phase === 'cleanup' }));
  return phase === 'cleanup' ? result.nativeAudit : result;
}

if (process.argv[1]?.endsWith('host-probe.mjs')) {
  const [phase, root, owner, expectedRoot, handoff] = process.argv.slice(2);
  try { console.log(JSON.stringify(await runPrivateKeyringPhase({ phase, root, owner, expectedRoot, handoff }))); }
  catch { console.error('private_keyring_rpc_failed'); process.exitCode = 2; }
}
