import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { secureWindowsKnowledgeBaseline } from './windows-project-knowledge-baseline.mjs';
import { V1, sha256 } from './project-knowledge-fixture.mjs';

const relative = '.kcoder\\specs\\specs\\core\\spec.md';
const path = 'D:\\owned\\run\\state\\workspaces\\project-knowledge\\' + relative;
const receipt = () => ({ path, relative, currentSid: 'S-1-5-21-123-1001', ownerSid: 'S-1-5-21-123-1001',
  protected: true, singleLink: true, nonReparse: true, aceCount: 1, bytes: Buffer.byteLength(V1),
  sha256Before: sha256(V1), sha256After: sha256(V1), identityBefore: '1:2:3:0:216', identityAfter: '1:2:3:0:216' });
function context() {
  return { sourceRelative: 'apps/kcoder-studio/e2e/suites/gateway/project-knowledge-publication.e2e.mjs',
    runRoot: 'D:\\owned\\run', stateDir: 'D:\\owned\\run\\state',
    pathInState: name => 'D:\\owned\\run\\state\\' + name,
    isolatedEnvironment: value => value, writeArtifactJson: async () => {} };
}

test('the baseline adapter fixes one immutable source path and V1 SHA, retaining the verified file receipt', async () => {
  const current = context(); let artifact;
  current.writeArtifactJson = async (name, value) => { artifact = { name, value }; };
  const actual = await secureWindowsKnowledgeBaseline(current, { systemRoot: 'C:\\Windows',
    execute: async (command, args, options) => {
      assert.equal(command, 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe');
      assert.equal(args[args.indexOf('-RunRoot') + 1], current.runRoot);
      assert.equal(args[args.indexOf('-ExpectedSha256') + 1], sha256(V1));
      assert.equal(args.includes('-Path'), false); assert.equal(args.includes('-FilePath'), false);
      assert.equal(options.timeout, 30000); assert.equal(options.windowsHide, true);
      assert.equal(options.env.TEMP, 'D:\\owned\\run\\state\\tmp');
      return { stdout: JSON.stringify(receipt()) };
    } });
  assert.equal(actual.sha256After, sha256(V1));
  assert.equal(artifact.name, 'knowledge-windows-baseline-owner.json');
  assert.match(artifact.value.script.sha256, /^[a-f0-9]{64}$/);
});

test('another scenario or non-owned state is rejected before starting PowerShell', async () => {
  for (const patch of [{ sourceRelative: 'another-scenario' }, { stateDir: 'D:\\personal' }, { runRoot: '\\\\server\\share' }]) {
    let started = false;
    await assert.rejects(secureWindowsKnowledgeBaseline({ ...context(), ...patch }, { systemRoot: 'C:\\Windows',
      execute: async () => { started = true; } }));
    assert.equal(started, false);
  }
});

test('a command success cannot substitute wrong bytes, owner, private DACL or stable ordinary file identity', async () => {
  for (const patch of [{ path: 'D:\\personal\\spec.md' }, { relative: 'another.md' },
    { ownerSid: 'S-1-5-32-544' }, { protected: false }, { aceCount: 2 }, { singleLink: false }, { nonReparse: false },
    { sha256Before: '0'.repeat(64) }, { sha256After: '0'.repeat(64) }, { bytes: 0 }, { identityAfter: '9:9:9:0:216' }]) {
    await assert.rejects(secureWindowsKnowledgeBaseline(context(), { systemRoot: 'C:\\Windows',
      execute: async () => ({ stdout: JSON.stringify({ ...receipt(), ...patch }) }) }));
  }
});

test('the Windows helper is a bounded new-baseline operation, never a recursive ACL or Native publication repair', async () => {
  const script = await readFile(new URL('windows-project-knowledge-baseline.ps1', import.meta.url), 'utf8');
  assert.match(script, /Only the fixed initial V1 baseline/);
  assert.match(script, /manifest\.status -cne 'running'/);
  assert.match(script, /\.kcoder\\specs\\specs\\core\\spec\.md/);
  assert.match(script, /Only the initial baseline chain may exist/);
  assert.match(script, /info\.Links!=1/);
  assert.match(script, /CreateFile\(path,0x1f01ff,1,IntPtr.Zero,3,0x00200000/);
  assert.match(script, /\$file\.SetAccessControl\(\$acl\)/);
  assert.match(script, /\$acl\.SetOwner\(\$sid\)/);
  assert.match(script, /\$file\.Dispose\(\)/);
  assert.doesNotMatch(script, /Set-Acl|icacls|takeown|SeRestorePrivilege|SeTakeOwnershipPrivilege|ScheduledTask|CreateProcessWithLogon|SwitchDesktop|Remove-Item|Copy-Item/);
});
