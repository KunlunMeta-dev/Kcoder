import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { lstat, mkdir, open, readFile, rename, writeFile } from 'node:fs/promises';
import { isAbsolute, join, relative, resolve } from 'node:path';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import { spawnWindowsSupervised, stopSupervisedProcess } from './owned-process.mjs';
import { ownedCreationScript, psLiteral } from './windows-owned-root.mjs';

const crossVolumeTest = 'storage::component_publication::tests::windows_cross_volume_publication_recovers_original_operation_and_preserves_source';
const retainedDirectoryTest = 'private_files::cache_links::tests::retaining_an_ordinary_directory_preserves_identity_and_contents';
const retainedFencedDirectoryTest = 'private_files::cache_links::tests::directory_rename_with_held_fences_respects_platform_rules';
const recoveredPublicationTest = 'storage::component_publication::tests::recovered_publication_rechecks_original_source_without_recopying_the_target';
const publicationPendingGateTest = 'storage::component_publication::tests::windows_publication_pending_gate_covers_released_target_fences_and_preserves_source_exclusion';
const publicationInterruptedWindowTest = 'storage::component_publication::tests::windows_publication_reacquires_original_fences_after_an_interrupted_rename_window';
const publicationRestoreMismatchTest = 'storage::component_publication::tests::windows_publication_restore_rejects_a_replaced_fence_and_keeps_pending_admission_closed';
const publicationNestedFencesTest = 'storage::component_publication::tests::publication_follows_nested_fences_without_replacing_their_original_files';

export function assertVhdImageIdentity(ready, named, held) {
  const expectedInode = (BigInt(ready.image_identity.file_index_high) << 32n) + BigInt(ready.image_identity.file_index_low);
  assert.ok(named.isFile() && held.isFile() && !named.isSymbolicLink());
  assert.equal(named.nlink, 1n); assert.equal(held.nlink, 1n);
  assert.equal(named.ino, expectedInode); assert.equal(held.ino, expectedInode);
  assert.equal(held.dev, BigInt(ready.image_identity.volume_serial));
}

export function vhdReadyEvent(line) {
  const prefix = 'test owned_vhdx_fixture ... ';
  const frame = line.startsWith(prefix) ? line.slice(prefix.length) : line;
  if (!frame.startsWith('{')) return null;
  try {
    const event = JSON.parse(frame);
    return event.event === 'READY' ? event : null;
  } catch { return null; }
}

export function validateStorageLibtestOutput(args, stdout, code) {
  assert.equal(code, 0, 'NativeFS libtest failed; retain its original output');
  const exact = args.includes('--exact') ? args.find(value => !value.startsWith('-')) : null;
  if (args.includes('--list')) {
    const names = [...stdout.matchAll(/^(\S+): test\r?$/gm)].map(match => match[1]);
    assert.ok(names.length > 0, 'NativeFS selection matched no tests');
    if (exact) assert.deepEqual(names, [exact], 'NativeFS exact selection must match its original case');
    return;
  }
  const summary = /^test result: ok\. (\d+) passed; (\d+) failed; (\d+) ignored; (\d+) measured;/m.exec(stdout);
  assert.ok(summary && Number(summary[1]) > 0 && summary[2] === '0' && summary[4] === '0',
    'NativeFS success requires actual passing tests, not only a zero exit code');
  if (exact) {
    assert.equal(summary[1], '1');
    assert.equal(summary[3], '0');
  }
}

// This composes the existing Job owner for fixed NativeFS source suites only.
// It never resolves a product Home, launches a service or executes the CLI.
async function main() {
  assert.equal(process.platform, 'win32');
  const input = JSON.parse(await readFile(process.argv[2], 'utf8'));
  const root = resolve(input.root), app = join(root, 'app');
  assert.equal(JSON.parse(await readFile(join(root, '.owner.json'), 'utf8')).owner, input.owner);
  const hash = bytes => createHash('sha256').update(bytes).digest('hex');
  for (const [leaf, expected] of Object.entries(input.artifacts)) {
    assert.ok(['tests.exe', 'fs-tests.exe', 'vhd-tests.exe', 'config-tests.exe', 'windows-storage-owned-volume.ps1',
      'supervisor.exe', 'app/target/debug/kcoder_native_storage.dll',
      'app/target/debug/kcoder-native-storage.node'].includes(leaf));
    assert.match(expected, /^[a-f0-9]{64}$/);
    const digest = createHash('sha256');
    for await (const bytes of createReadStream(join(root, leaf))) digest.update(bytes);
    assert.equal(digest.digest('hex'), expected);
  }
  for (const source of input.sources) {
    assert.equal(typeof source.source, 'string');
    const path = resolve(app, source.source), local = relative(app, path);
    assert.ok(local && !isAbsolute(local) && !local.split(/[\\/]/).includes('..'));
    assert.equal(hash(await readFile(path)), source.sha256);
  }
  const node = process.execPath;
  const studio = path => join(app, 'apps/kcoder-studio', path);
  const relay = path => join(app, 'apps/kcoder-relay', path);
  if (['retained-directory-list', 'retained-directory', 'retained-fenced-directory-list', 'retained-fenced-directory'].includes(input.group)) {
    assert.ok(Object.hasOwn(input.artifacts, 'fs-tests.exe'), 'Directory retention tests belong to the pinned filesystem libtest');
  }
  if (['recovered-publication-list', 'recovered-publication', 'publication-pending-gate-list',
    'publication-pending-gate', 'publication-interrupted-window-list', 'publication-interrupted-window',
    'publication-restore-mismatch-list', 'publication-restore-mismatch',
    'publication-nested-fences-list', 'publication-nested-fences'].includes(input.group)) {
    assert.ok(Object.hasOwn(input.artifacts, 'config-tests.exe'), 'Publication recovery tests require the pinned Config libtest');
  }
  const crossVolume = input.group === 'vhd-config-cross-volume';
  const vhd = crossVolume || ['vhd-stop', 'vhd-controller-eof', 'vhd-deadline'].includes(input.group);
  if (crossVolume) {
    for (const artifact of ['config-tests.exe', 'supervisor.exe', 'windows-storage-owned-volume.ps1']) {
      assert.ok(Object.hasOwn(input.artifacts, artifact), 'Cross-volume proof requires all pinned fixed inputs');
    }
  }
  if (vhd) {
    assert.ok(Object.hasOwn(input.artifacts, 'vhd-tests.exe'), 'VHD qualification requires its pinned test executable');
    await writeFile(join(root, 'vhdx-request.json'), JSON.stringify({ owner: input.owner,
      maximum_size_bytes: 64 * 1024 * 1024,
      budget_ms: crossVolume ? 300000 : input.group === 'vhd-deadline' ? 5000 : 60000 }), { flag: 'wx' });
  }
  const vhdArgs = ['--ignored', '--exact', 'owned_vhdx_fixture', '--nocapture', '--test-threads=1'];
  const cases = {
    'rust-list': [join(root, 'tests.exe'), ['--list']],
    'rust-unit': [join(root, 'tests.exe'), ['--test-threads=1']],
    'retained-directory-list': [join(root, 'fs-tests.exe'), [retainedDirectoryTest, '--exact', '--list']],
    'retained-directory': [join(root, 'fs-tests.exe'), [retainedDirectoryTest, '--exact', '--nocapture', '--test-threads=1']],
    'retained-fenced-directory-list': [join(root, 'fs-tests.exe'), [retainedFencedDirectoryTest, '--exact', '--list']],
    'retained-fenced-directory': [join(root, 'fs-tests.exe'), [retainedFencedDirectoryTest, '--exact', '--nocapture', '--test-threads=1']],
    'recovered-publication-list': [join(root, 'config-tests.exe'), [recoveredPublicationTest, '--exact', '--list']],
    'recovered-publication': [join(root, 'config-tests.exe'), [recoveredPublicationTest, '--exact', '--nocapture', '--test-threads=1']],
    'publication-pending-gate-list': [join(root, 'config-tests.exe'), [publicationPendingGateTest, '--exact', '--list']],
    'publication-pending-gate': [join(root, 'config-tests.exe'), [publicationPendingGateTest, '--exact', '--nocapture', '--test-threads=1']],
    'publication-interrupted-window-list': [join(root, 'config-tests.exe'), [publicationInterruptedWindowTest, '--exact', '--list']],
    'publication-interrupted-window': [join(root, 'config-tests.exe'), [publicationInterruptedWindowTest, '--exact', '--nocapture', '--test-threads=1']],
    'publication-restore-mismatch-list': [join(root, 'config-tests.exe'), [publicationRestoreMismatchTest, '--exact', '--list']],
    'publication-restore-mismatch': [join(root, 'config-tests.exe'), [publicationRestoreMismatchTest, '--exact', '--nocapture', '--test-threads=1']],
    'publication-nested-fences-list': [join(root, 'config-tests.exe'), [publicationNestedFencesTest, '--exact', '--list']],
    'publication-nested-fences': [join(root, 'config-tests.exe'), [publicationNestedFencesTest, '--exact', '--nocapture', '--test-threads=1']],
    'vhd-stop': [join(root, 'vhd-tests.exe'), vhdArgs],
    'vhd-controller-eof': [join(root, 'vhd-tests.exe'), vhdArgs],
    'vhd-deadline': [join(root, 'vhd-tests.exe'), vhdArgs],
    'vhd-config-cross-volume': [join(root, 'vhd-tests.exe'), vhdArgs],
    observation: [node, ['--test', studio('test/storage-native-observation.test.js')]],
    'owned-node': [node, ['--expose-gc', join(app, 'crates/kcoder_native_storage/tests/owned-node.mjs'),
      join(app, 'target/debug/kcoder-native-storage.node')]],
    loader: [node, ['--test', studio('src/storage-native-loader.test.mjs')]],
    'relay-core': [node, ['--test', '--test-name-pattern=client identity saves|completed identity binds|concurrent first starts|managed identity paths|startup adopts|interrupted identity relocation|conflicting identities|identity relocation rejects|damaged and oversized|removing a pointer', relay('test/client-identity.test.mjs')]],
    'relay-long-path': [node, ['--test', '--test-name-pattern=identity registration and revocation use owned Unicode', relay('test/client-identity-windows-stat.test.mjs')]],
    'relay-synthetic-stat': [node, ['--test', '--test-name-pattern=Windows path snapshots|Windows named reopen|Windows named snapshot', relay('test/client-identity-windows-stat.test.mjs')]],
    'relay-offline-source': [node, ['--test', relay('test/client-identity-offline-source.test.mjs')]],
  };
  assert.ok(Object.hasOwn(cases, input.group));
  const temporary = join(root, 'temporary');
  await mkdir(temporary, { recursive: true });
  const environment = Object.fromEntries(['SystemRoot', 'WINDIR', 'PATH', 'COMSPEC', 'PATHEXT', 'OS',
    'PROCESSOR_ARCHITECTURE'].filter(name => process.env[name]).map(name => [name, process.env[name]]));
  Object.assign(environment, { TEMP: temporary, TMP: temporary, KCODER_TARGET_DIR: join(app, 'target'), RUST_BACKTRACE: '0' });
  if (vhd) environment.KCODER_E2E_OWNED_VHDX_ROOT = root;
  process.env.KCODER_E2E_PROCESS_SUPERVISOR_BIN = join(root, 'supervisor.exe');
  const creationTicks = execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
    `(Get-Process -Id ${process.pid}).StartTime.ToUniversalTime().Ticks.ToString()`],
  { windowsHide: true, timeout: 10000, encoding: 'utf8' }).trim();
  assert.match(creationTicks, /^\d+$/);
  await writeFile(join(root, 'probe-owner.json'), JSON.stringify({ owner: input.owner, pid: process.pid,
    creationTicks, creationKind: 'process-start-time' }));
  let active, nested, finished = false;
  const authority = createInterface({ input: process.stdin });
  authority.on('close', () => {
    if (!finished) {
      // EOF closes the existing supervisor control pipe and its kill-on-close Job.
      active?.stdin.destroy();
      nested?.child.stdin.destroy();
      process.exit(2);
    }
  });
  const token = await new Promise((accept, reject) => {
    authority.once('line', line => { try { accept(JSON.parse(line)); } catch { reject(Error('Invalid NativeFS owner')); } });
    authority.once('close', () => { if (!finished) reject(Error('NativeFS owner disconnected')); });
  });
  assert.equal(token.owner, input.owner);
  const [executable, args] = cases[input.group], started = performance.now();
  const { child, identity } = spawnWindowsSupervised(executable, args,
    { cwd: app, env: environment, stdio: ['ignore', 'pipe', 'pipe'] }, join(root, 'process-status'));
  active = child;
  let stdout = '', stderr = '', bytes = 0;
  let acceptVhdReady;
  const vhdReady = vhd ? new Promise(accept => { acceptVhdReady = accept; }) : null;
  const completed = new Promise((accept, reject) => {
    const collect = (field, part) => {
      bytes += part.length;
      if (bytes > 128 * 1024) { active.stdin.destroy(); reject(Error('NativeFS output budget')); }
      else if (field === 'stdout') {
        stdout += part;
        if (acceptVhdReady) {
          for (const line of stdout.split(/\r?\n/).slice(0, -1)) {
            const event = vhdReadyEvent(line);
            if (event) { acceptVhdReady(event); acceptVhdReady = undefined; break; }
          }
        }
      } else stderr += part;
    };
    child.stdout.on('data', part => collect('stdout', part));
    child.stderr.on('data', part => collect('stderr', part));
    child.once('error', reject);
    child.once('close', code => accept(code));
  });
  void completed.catch(() => {});
  let timer, crossVolumeResult;
  try {
    await identity.readyPromise;
    const observed = (async () => {
      if (vhd) {
        const ready = await Promise.race([vhdReady, completed.then(() => { throw Error('VHD fixture exited before READY'); })]);
        assert.equal(ready.owner, input.owner);
        assert.equal(ready.image_path, join(root, 'cross-volume.vhdx'));
        assert.equal(ready.maximum_size_bytes, 64 * 1024 * 1024);
        assert.equal(ready.dynamic, true);
        assert.equal(ready.permanent_lifetime, false);
        assert.equal(ready.automatic_drive_letter, false);
        await writeFile(join(root, 'vhdx-stdout.log'), stdout);
        const job = { helperPid: identity.pid, targetPid: identity.targetPid, statusFile: identity.statusFile };
        if (crossVolume) Object.assign(job, JSON.parse(execFileSync('powershell.exe',
          ['-NoProfile', '-NonInteractive', '-Command',
            '@{helperCreationTicks=(Get-Process -Id ' + identity.pid +
            ').StartTime.ToUniversalTime().Ticks.ToString();targetCreationTicks=(Get-Process -Id ' + identity.targetPid +
            ').StartTime.ToUniversalTime().Ticks.ToString()}|ConvertTo-Json -Compress'],
          { windowsHide: true, timeout: 10000, encoding: 'utf8' })));
        await writeFile(join(root, 'vhdx-ready.json.tmp'), JSON.stringify({ group: input.group, ready, job }));
        await rename(join(root, 'vhdx-ready.json.tmp'), join(root, 'vhdx-ready.json'));
        if (input.group === 'vhd-stop') {
          await writeFile(join(root, 'stop.json.tmp'), JSON.stringify({ owner: input.owner, command: 'STOP' }), { flag: 'wx' });
          await rename(join(root, 'stop.json.tmp'), join(root, 'stop.json'));
        }
        if (crossVolume) {
          const image = await open(ready.image_path, 'r');
          const steps = [];
          let targetRoot, prepared, failure;
          async function step(stage) {
            const config = stage === 'config-list' || stage === 'config-test';
            const script = stage === 'prepare-volume' ? await readFile(join(root, 'windows-storage-owned-volume.ps1'), 'utf8')
              : stage === 'create-target' ? ownedCreationScript(prepared.parent, input.owner)
              : 'Get-DiskImage -ImagePath ' + psLiteral(ready.image_path) +
                ' -ErrorAction Stop|ForEach-Object{if($_.Attached){throw "Original image is still attached"};@{imagePath=$_.ImagePath;attached=[bool]$_.Attached}|ConvertTo-Json -Compress}';
            const command = config ? join(root, 'config-tests.exe') : join(process.env.SystemRoot, 'System32/WindowsPowerShell/v1.0/powershell.exe');
            const args = config ? [crossVolumeTest, ...(stage === 'config-list' ? ['--list']
              : ['--exact', '--ignored', '--nocapture', '--test-threads=1'])]
              : ['-NoProfile', '-NonInteractive', '-EncodedCommand',
                Buffer.from("$ErrorActionPreference='Stop';$ProgressPreference='SilentlyContinue';[Console]::OutputEncoding=[Text.UTF8Encoding]::new($false);" + script, 'utf16le').toString('base64')];
            const launched = spawnWindowsSupervised(command, args, { cwd: app,
              env: { ...environment, KCODER_E2E_STORAGE_CROSS_VOLUME: '1',
                ...(targetRoot ? { KCODER_E2E_STORAGE_CROSS_VOLUME_ROOT: targetRoot } : {}) },
              stdio: ['ignore', 'pipe', 'pipe'] }, join(root, 'process-status'));
            nested = launched;
            let output = '', errors = '', count = 0, deadline;
            const ended = new Promise((accept, reject) => {
              for (const [stream, append] of [[launched.child.stdout, part => { output += part; }],
                [launched.child.stderr, part => { errors += part; }]]) stream.on('data', part => {
                count += part.length;
                if (count > 128 * 1024) { launched.child.stdin.destroy(); reject(Error('Cross-volume output budget')); }
                else append(part);
              });
              launched.child.once('error', reject);
              launched.child.once('close', accept);
            });
            void ended.catch(() => {});
            try {
              await launched.identity.readyPromise;
              const code = await Promise.race([ended, new Promise((_, reject) => {
                deadline = setTimeout(() => reject(Error('Cross-volume step deadline')), 60000);
              })]);
              const result = { stage, code, stdout: output, stderr: errors, helperPid: launched.identity.pid,
                targetPid: launched.identity.targetPid, closed: launched.identity.closed,
                status: await readFile(launched.identity.statusFile, 'utf8') };
              steps.push(result);
              await writeFile(join(root, 'cross-volume-' + stage + '.json'), JSON.stringify(result));
              assert.equal(result.closed, true); assert.equal(code, 0, errors + output);
              return result;
            } finally {
              clearTimeout(deadline);
              await stopSupervisedProcess(launched.child, launched.identity);
              nested = undefined;
            }
          }
          try {
            assertVhdImageIdentity(ready, await lstat(ready.image_path, { bigint: true }), await image.stat({ bigint: true }));
            const listed = await step('config-list');
            assert.deepEqual([...listed.stdout.matchAll(/^(\S+): test$/gm)].map(match => match[1]), [crossVolumeTest]);
            assertVhdImageIdentity(ready, await lstat(ready.image_path, { bigint: true }), await image.stat({ bigint: true }));
            prepared = JSON.parse((await step('prepare-volume')).stdout.trim());
            assert.match(prepared.parent, /^[D-Z]:\\$/);
            targetRoot = JSON.parse((await step('create-target')).stdout.trim());
            assert.equal(targetRoot, join(prepared.parent, 'kcoder-package-' + input.owner));
            const tested = await step('config-test');
            assert.match(tested.stdout, /test result: ok\. 1 passed; 0 failed; 0 ignored;/);
          } catch (error) { failure = error; }
          try {
            await writeFile(join(root, 'stop.json.tmp'), JSON.stringify({ owner: input.owner, command: 'STOP' }), { flag: 'wx' });
            await rename(join(root, 'stop.json.tmp'), join(root, 'stop.json'));
            assert.equal(await completed, 0, 'The original VHD fixture must complete its owned STOP');
            const detached = JSON.parse((await step('confirm-detached')).stdout.trim());
            assert.equal(detached.imagePath, ready.image_path);
            assert.equal(detached.attached, false);
            assertVhdImageIdentity(ready, await lstat(ready.image_path, { bigint: true }), await image.stat({ bigint: true }));
          } catch (error) { failure ??= error; }
          finally { await image.close(); }
          crossVolumeResult = { steps, targetRoot, prepared, error: failure?.message,
            scope: 'Current Config source-only exact case; no CLI or actual product Home' };
          await writeFile(join(root, 'cross-volume-result.json'), JSON.stringify(crossVolumeResult));
          if (failure) throw failure;
        }
        // The EOF case waits for the original external owner's stdin to close.
        // The existing authority handler then exits and releases the original Job pipe.
      }
      return completed;
    })();
    const code = await Promise.race([observed, new Promise((_, reject) => {
      timer = setTimeout(() => reject(Error('NativeFS group deadline')), 180000);
    })]);
    assert.equal(identity.closed, true, 'the original Job helper must actually exit');
    const status = await readFile(identity.statusFile, 'utf8');
    const result = { group: input.group, code, stdout, stderr, elapsedMs: performance.now() - started,
      node: process.version, platform: process.platform, crossVolume: crossVolumeResult, job: { helperPid: identity.pid, targetPid: identity.targetPid,
        closed: identity.closed, status }, scope: 'NativeFS/source-only; no CLI, product Home, HKCU, model or business network' };
    if (vhd) await writeFile(join(root, 'vhdx-result.json'), JSON.stringify(result));
    console.log(JSON.stringify(result));
    if (executable.endsWith('tests.exe')) validateStorageLibtestOutput(args, stdout, code);
    else assert.equal(code, 0, 'NativeFS group failed; retain its original output');
  } finally {
    clearTimeout(timer);
    try {
      if (nested) await stopSupervisedProcess(nested.child, nested.identity);
    } finally {
      await stopSupervisedProcess(child, identity);
      active = undefined;
      finished = true;
      authority.close();
    }
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(error => { console.error(error.stack); process.exitCode = 1; });
}
