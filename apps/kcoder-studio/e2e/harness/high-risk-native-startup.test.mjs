import assert from 'node:assert/strict';
import { homedir } from 'node:os';
import { mkdir, readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { waitForStdioChildClose } from './app-server-stdio.mjs';
import { pollNative, sha256File, startNativeCodeManager } from './native-code-service.mjs';
import { isolatedEnvironment, RunContext } from './run-context.mjs';

const manifest = fileURLToPath(new URL('../../../../crates/kcoder_cli/tests/fixtures/native-manager-owned-startup-probe/Cargo.toml', import.meta.url));

test('manager submission failure creates no fixture fence and cannot reuse another owned label', async () => {
  const fixture = { activeManagers: new Set(), binary: '/owned/manager', profile: '/owned/profile', workspace: '/owned/workspace', env: {} };
  let submissions = 0;
  const context = { processes: new Map(), spawnOwned() { submissions++; throw new Error('submission rejected before process creation'); } };
  await assert.rejects(startNativeCodeManager(context, fixture, 'owned-manager'), /submission rejected/);
  assert.equal(fixture.activeManagers.size, 0);
  context.processes.set('peer-manager', {});
  await assert.rejects(startNativeCodeManager(context, fixture, 'peer-manager'), /cannot be reused/);
  assert.equal(fixture.activeManagers.size, 0);
  assert.equal(submissions, 1);
});

test('offline owned startup protocol recovers original resources through real pipes and Child waits', { skip: process.platform !== 'linux' }, async t => {
  const build = await RunContext.create(import.meta.url, { testId: 'native-owned-startup-build', retainSuccessLogs: true });
  let failure;
  try {
    const target = build.pathInState('cargo-target');
    const compiler = build.spawnOwned('compile-original-startup-leaf', 'cargo', [
      'build', '--locked', '--offline', '--manifest-path', manifest, '--target-dir', target,
    ], { env: isolatedEnvironment({
      CARGO_HOME: process.env.CARGO_HOME ?? join(homedir(), '.cargo'),
      RUSTUP_HOME: process.env.RUSTUP_HOME ?? join(homedir(), '.rustup'),
    }) });
    assert.equal((await waitForStdioChildClose(compiler, 60_000, 'startup probe build')).code, 0);
    const binary = join(target, 'debug/kcoder-native-manager-owned-startup-probe');
    const imageSha256 = await sha256File(binary);

    const runCase = async (name, mode, body, { expectedUnknown = false, cleanupError = /complete worker drain receipt/ } = {}) => t.test(name, async () => {
      const context = await RunContext.create(import.meta.url, { testId: name, retainSuccessLogs: true });
      let caseFailure;
      try {
        const profile = context.pathInState('profile'), workspace = context.pathInState('workspace');
        await mkdir(profile); await mkdir(workspace);
        const fixture = { binary, profile, workspace, uid: process.getuid(), gid: process.getgid(), imageSha256,
          activeManagers: new Set(), env: isolatedEnvironment({ KCODER_NATIVE_STARTUP_PROBE_MODE: mode }) };
        await body(context, fixture);
        await context.writeArtifactJson('offline-startup-boundary.json', {
          productionLeaf: 'user_manager_startup.rs', modelIndependent: true, actualPrivatePipeAndChildWait: true,
          fullNativeInventoryOrAccountAcceptance: false, expectedUnknown,
        });
      } catch (error) { caseFailure = error; }
      if (expectedUnknown && !caseFailure) {
        await assert.rejects(context.finish('passed', { expectedNegative: name }),
          cleanupError);
        assert.ok((await stat(context.stateDir)).isDirectory(), 'Unknown fixture State remains retained');
      } else {
        await context.finish(caseFailure ? 'failed' : 'passed', { offlineProcessProbe: true }, caseFailure);
        if (caseFailure) throw caseFailure;
      }
    });

    await runCase('native-owned-ready-loss', 'ready-lost', async (context, fixture) => {
      await assert.rejects(startNativeCodeManager(context, fixture, 'original-manager', { startupTimeoutMs: 40 }), error => {
        assert.equal(error.nativeManagerStartup.state, 'startup_failed_cleanup_confirmed');
        assert.equal(error.nativeManagerStartup.cleanup.managerReceipt.startupReleased, false);
        assert.equal(error.nativeManagerStartup.startMayHaveBeenDelivered, false);
        return true;
      });
      assert.equal(fixture.activeManagers.size, 0);
      await assert.rejects(stat(join(fixture.workspace, 'worker-started')), { code: 'ENOENT' });
    });

    await runCase('native-owned-observer-failure', '', async (context, fixture) => {
      fixture.imageSha256 = '0'.repeat(64);
      await assert.rejects(startNativeCodeManager(context, fixture, 'original-manager'), error => {
        assert.equal(error.nativeManagerStartup.state, 'startup_failed_cleanup_confirmed');
        assert.equal(error.nativeManagerStartup.startupPhase, 'observer_submitted');
        assert.equal(error.nativeManagerStartup.cleanup.managerReceipt.startupReleased, false);
        return true;
      });
      assert.equal(fixture.activeManagers.size, 0);
      await assert.rejects(stat(join(fixture.workspace, 'worker-started')), { code: 'ENOENT' });
    });

    await runCase('native-owned-go-write-receipt-loss', '', async (context, fixture) => {
      const spawn = context.spawnOwned.bind(context);
      context.spawnOwned = (...args) => {
        const child = spawn(...args);
        if (args[0] === 'original-manager') {
          const write = child.stdin.write.bind(child.stdin);
          child.stdin.write = (bytes, callback) => write(bytes, error => {
            if (error) return callback(error);
            void pollNative(async () => readFile(join(fixture.workspace, 'worker-started'), 'utf8').catch(() => null),
              'actual child activated before losing the GO write receipt', 5000)
              .then(() => callback(new Error('GO write receipt deliberately lost')), callback);
          });
        }
        return child;
      };
      await assert.rejects(startNativeCodeManager(context, fixture, 'original-manager'), error => {
        assert.equal(error.nativeManagerStartup.state, 'startup_failed_cleanup_confirmed');
        assert.equal(error.nativeManagerStartup.startMayHaveBeenDelivered, true);
        assert.equal(error.nativeManagerStartup.cleanup.managerReceipt.startupReleased, true);
        assert.equal(error.nativeManagerStartup.cleanup.workerExitProvedBy, 'original_manager_complete_child_wait_receipt');
        return true;
      });
      assert.equal(await readFile(join(fixture.workspace, 'worker-stopped'), 'utf8'), '1');
      assert.equal(fixture.activeManagers.size, 0);
    });

    await runCase('native-owned-unattached-child-drain', '', async (context, fixture) => {
      const manager = await startNativeCodeManager(context, fixture, 'original-manager');
      await pollNative(async () => readFile(join(fixture.workspace, 'worker-started'), 'utf8').catch(() => null), 'actual unattached child', 5000);
      const stopped = await manager.close();
      assert.deepEqual(stopped.workers, [], 'No lease was attached to the observer');
      assert.equal(stopped.managerReceipt.startupReleased, true);
      assert.equal(stopped.workerExitProvedBy, 'original_manager_complete_child_wait_receipt');
      assert.equal(await readFile(join(fixture.workspace, 'worker-stopped'), 'utf8'), '1');
      assert.equal(fixture.activeManagers.size, 0);
    });

    await runCase('native-owned-reject-legacy-zero-exit', 'legacy-no-receipt', async (context, fixture) => {
      await assert.rejects(startNativeCodeManager(context, fixture, 'original-manager', { startupTimeoutMs: 40 }), error => {
        assert.equal(error.nativeManagerStartup.state, 'unknown_startup');
        assert.equal(error.nativeManagerStartup.retainFixtureAndProfile, true);
        assert.equal(error.nativeManagerStartup.completeWorkerAuthority, 'not_confirmed');
        return true;
      });
      assert.equal(fixture.activeManagers.has('original-manager'), true);
    }, { expectedUnknown: true });

    await runCase('native-owned-reject-released-receipt-before-go', 'ready-lost-forged-released', async (context, fixture) => {
      await assert.rejects(startNativeCodeManager(context, fixture, 'original-manager', { startupTimeoutMs: 40 }), error => {
        assert.equal(error.nativeManagerStartup.state, 'unknown_startup');
        assert.equal(error.nativeManagerStartup.startMayHaveBeenDelivered, false);
        return true;
      });
      assert.equal(fixture.activeManagers.has('original-manager'), true);
    }, { expectedUnknown: true, cleanupError: /startup phase/ });

    await runCase('native-owned-crash-cannot-use-empty-observer-as-complete-inventory', '', async (context, fixture) => {
      const manager = await startNativeCodeManager(context, fixture, 'original-manager');
      await pollNative(async () => readFile(join(fixture.workspace, 'worker-started'), 'utf8').catch(() => null), 'actual unattached child before crash', 5000);
      assert.deepEqual((await manager.request('observe')).workers, []);
      const crash = await manager.crash();
      await assert.rejects(crash.completion, /complete.*quiescence/);
      assert.equal(fixture.activeManagers.has('original-manager'), true);
      await assert.rejects(stat(join(fixture.workspace, 'worker-stopped')), { code: 'ENOENT' });
    }, { expectedUnknown: true, cleanupError: /complete.*quiescence/ });

    await runCase('native-owned-crash-manager-only-records-unknown-without-scope-authority', '', async (context, fixture) => {
      const manager = await startNativeCodeManager(context, fixture, 'original-manager');
      await pollNative(async () => readFile(join(fixture.workspace, 'worker-started'), 'utf8').catch(() => null), 'actual unattached child before manager-only crash', 5000);
      const crash = await manager.crashManagerOnly();
      assert.equal(crash.state, 'unknown_after_manager_crash');
      assert.equal(crash.completeWorkerAuthority, 'not_confirmed');
      assert.equal(crash.retainFixtureAndProfile, true);
      await assert.rejects(manager.close(), /complete.*quiescence/);
      assert.equal(fixture.activeManagers.has('original-manager'), true);
    }, { expectedUnknown: true, cleanupError: /complete.*quiescence/ });

    await runCase('native-owned-child-error-drains-later-worker-without-success-receipt', 'lost-child-status', async (context, fixture) => {
      const manager = await startNativeCodeManager(context, fixture, 'original-manager');
      await pollNative(async () => readFile(join(fixture.workspace, 'worker-started'), 'utf8').catch(() => null), 'later original child before lost-status cleanup', 5000);
      await assert.rejects(manager.close(), /must confirm cleanup/);
      assert.equal(await readFile(join(fixture.workspace, 'worker-stopped'), 'utf8'), '1');
      assert.equal(fixture.activeManagers.has('original-manager'), true);
      const output = await readFile(context.processes.get('original-manager').logPath, 'utf8');
      assert.ok(!output.includes('native_code_service_manager_stopped'));
    }, { expectedUnknown: true, cleanupError: /must confirm cleanup/ });
  } catch (error) { failure = error; }
  await build.finish(failure ? 'failed' : 'passed', { productionStartupLeaf: true }, failure);
  if (failure) throw failure;
});
