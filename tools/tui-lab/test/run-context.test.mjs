import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, mkdir, readFile, rename, rm, stat, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  createRunContext,
  ensureDirectory,
  ensureTrustedDirectoryPath,
  materializeRunContext,
  secureWindowsPrivateDirectory,
  verifyRunContextIntegrity,
  verifyWindowsDirectory,
} from '../lib/run-context.mjs';

function directoryState(mode, overrides = {}) {
  return {
    dev: 1,
    ino: 2,
    mode,
    uid: process.getuid?.() ?? 0,
    gid: process.getgid?.() ?? 0,
    isDirectory: () => true,
    isSymbolicLink: () => false,
    ...overrides,
  };
}

function fsError(code, message = code) {
  return Object.assign(new Error(message), { code });
}

function runtime(root, overrides = {}) {
  return {
    now: new Date(2026, 6, 29, 8, 9, 10, 11),
    pid: 42,
    platform: 'linux',
    cwd: root,
    targetRoot: path.join(root, 'target'),
    configRoot: path.join(root, 'config'),
    configTrustRoot: root,
    repoRoot: root,
    spawnSync,
    ...overrides,
  };
}

function options(root, overrides = {}) {
  return {
    scenario: 'full-turn',
    description: 'smoke run',
    out: path.join(root, 'artifacts'),
    workspaceTemplate: path.join(root, 'workspace-template'),
    ...overrides,
  };
}

test('builds stable run timestamp and sanitized path segments', () => {
  const layout = materializeRunContext(
    {
      scenario: 'full-turn',
      description: '  review / 中文 : run  ',
      out: '/artifacts',
      workspaceTemplate: '/fixtures/workspace',
    },
    'run',
    runtime('/repo'),
  );
  assert.equal(layout.dateStamp, '2026-07-29');
  assert.equal(layout.timeStamp, '08-09-10-011');
  assert.equal(layout.description, 'review-中文-run');
  assert.equal(
    materializeRunContext(
      { ...options('/repo'), description: '...' },
      'run',
      runtime('/repo'),
    ).description,
    'run',
  );
});

test('builds every artifact beneath one owned run directory', () => {
  const layout = materializeRunContext(
    {
      scenario: 'full-turn',
      description: 'smoke run',
      out: '/artifacts',
      workspaceTemplate: '/fixtures/workspace',
    },
    'run',
    {
      now: new Date(2026, 6, 29, 8, 9, 10, 11),
      pid: 42,
      platform: 'linux',
      cwd: '/repo',
      targetRoot: '/target',
      configRoot: '/config',
    },
  );
  assert.equal(layout.runId, '2026-07-29/08-09-10-011-smoke-run-42');
  assert.equal(layout.workspace, '/artifacts/2026-07-29/08-09-10-011-smoke-run-42/workspace');
  assert.equal(layout.configHome, '/config/2026-07-29/08-09-10-011-smoke-run-42');
  assert.equal(layout.finalScreenshot, path.join(layout.dir, 'after-final.png'));
  assert.equal(layout.projectKey, path.resolve(layout.workspace).replace(/[\\/:\s]/g, '_'));
  for (const value of Object.values(layout)) {
    if (typeof value === 'string' && value.startsWith(layout.dir)) {
      assert.equal(path.relative(layout.dir, value).startsWith('..'), false);
    }
  }
});

test('copies a real workspace template and rejects an existing destination', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'tui-lab-run-context-'));
  try {
    const template = path.join(root, 'workspace-template');
    await mkdir(path.join(template, 'nested'), { recursive: true });
    await writeFile(path.join(template, 'nested', 'fixture.txt'), 'fixture\n');

    const layout = await createRunContext(options(root), 'run', runtime(root));
    assert.equal(await readFile(path.join(layout.workspace, 'nested', 'fixture.txt'), 'utf8'), 'fixture\n');
    await assert.rejects(() => createRunContext(options(root), 'run', runtime(root)), /exist|EEXIST/i);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('creates public artifact directories and a private config directory on Unix', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'tui-lab-run-context-mode-'));
  try {
    const template = path.join(root, 'workspace-template');
    await mkdir(template, { recursive: true });
    const layout = await createRunContext(options(root), 'run', runtime(root));
    if (process.platform !== 'win32') {
      assert.equal((await stat(layout.baseDir)).mode & 0o777, 0o755);
      assert.equal((await stat(layout.dateDir)).mode & 0o777, 0o755);
      assert.equal((await stat(layout.dir)).mode & 0o777, 0o755);
      assert.equal((await stat(layout.configHome)).mode & 0o777, 0o700);
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('accepts an existing exact-mode writable directory without chmod', async () => {
  const calls = [];
  const state = directoryState(0o40755);
  const result = await ensureDirectory(
    '/artifacts/date',
    { mode: 0o755, platform: 'linux' },
    {
      fs: {
        async mkdir() {
          throw fsError('EEXIST');
        },
        async lstat() {
          calls.push('lstat');
          return state;
        },
        async access(_directory, mode) {
          calls.push(['access', mode]);
        },
        async chmod() {
          assert.fail('an existing exact-mode directory must not be chmodded');
        },
      },
    },
  );
  assert.equal(result.created, false);
  assert.deepEqual(calls, ['lstat', ['access', 3], 'lstat']);
});

test('does not expose a recursive directory creation branch', () => {
  assert.doesNotMatch(ensureDirectory.toString(), /if\s*\(\s*recursive/);
  assert.match(ensureDirectory.toString(), /mkdir\(directory, \{ recursive: false, mode \}\)/);
});

test('rejects existing group-writable and world-writable directories without changing them', async () => {
  for (const mode of [0o40775, 0o40777]) {
    let touched = false;
    await assert.rejects(
      () =>
        ensureDirectory('/artifacts/date', { mode: 0o755, platform: 'linux' }, {
          fs: {
            async mkdir() {
              throw fsError('EEXIST');
            },
            async lstat() {
              return directoryState(mode);
            },
            async access() {
              touched = true;
            },
            async chmod() {
              touched = true;
            },
          },
        }),
      /mode mismatch|untrusted writable/,
    );
    assert.equal(touched, false);
  }
});

test('rejects an existing exact-mode directory when write or search access is denied', async () => {
  await assert.rejects(
    () =>
      ensureDirectory('/artifacts/date', { mode: 0o755, platform: 'linux' }, {
        fs: {
          async mkdir() {
            throw fsError('EEXIST');
          },
          async lstat() {
            return directoryState(0o40755);
          },
          async access() {
            throw fsError('EACCES');
          },
          async chmod() {
            assert.fail('access denial must not trigger chmod');
          },
        },
      }),
    { code: 'EACCES' },
  );
});

test('rejects a symlink before access, chmod, or workspace copy can occur', async () => {
  let touched = false;
  await assert.rejects(
    () =>
      ensureDirectory('/artifacts/date', { mode: 0o755, platform: 'linux' }, {
        fs: {
          async mkdir() {
            throw fsError('EEXIST');
          },
          async lstat() {
            return directoryState(0o40755, {
              isDirectory: () => false,
              isSymbolicLink: () => true,
            });
          },
          async access() {
            touched = true;
          },
          async chmod() {
            touched = true;
          },
        },
      }),
    /unsafe directory path/,
  );
  assert.equal(touched, false);
});

test('stops createRunContext at a symlinked date directory before copying the workspace', async () => {
  if (process.platform === 'win32') return;
  const root = await mkdtemp(path.join(os.tmpdir(), 'tui-lab-run-context-symlink-'));
  try {
    const template = path.join(root, 'workspace-template');
    const base = path.join(root, 'artifacts');
    const redirect = path.join(root, 'redirect');
    await mkdir(template, { recursive: true });
    await writeFile(path.join(template, 'must-not-copy.txt'), 'unsafe\n');
    await mkdir(base, { mode: 0o755 });
    await mkdir(redirect, { mode: 0o755 });
    await symlink(redirect, path.join(base, '2026-07-29'));

    const layout = materializeRunContext(options(root), 'run', runtime(root));
    await assert.rejects(
      () => createRunContext(options(root), 'run', runtime(root)),
      /unsafe directory path/,
    );
    await assert.rejects(() => stat(path.join(layout.workspace, 'must-not-copy.txt')), { code: 'ENOENT' });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('repairs a newly created umask-restricted directory and revalidates its identity', async () => {
  let mode = 0o40750;
  const calls = [];
  const result = await ensureDirectory(
    '/artifacts/new-run',
    { mode: 0o755, mustCreate: true, platform: 'linux' },
    {
      fs: {
        async mkdir(_directory, options) {
          calls.push(['mkdir', options]);
        },
        async lstat() {
          calls.push('lstat');
          return directoryState(mode);
        },
        async chmod(_directory, requestedMode) {
          calls.push(['chmod', requestedMode]);
          mode = 0o40000 | requestedMode;
        },
        async access(_directory, requestedMode) {
          calls.push(['access', requestedMode]);
        },
      },
    },
  );
  assert.equal(result.created, true);
  assert.deepEqual(calls, [
    ['mkdir', { recursive: false, mode: 0o755 }],
    'lstat',
    ['chmod', 0o755],
    'lstat',
    ['access', 3],
    'lstat',
  ]);
});

test('fails closed when repairing a newly created directory is not permitted', async () => {
  await assert.rejects(
    () =>
      ensureDirectory('/artifacts/new-run', { mode: 0o755, mustCreate: true, platform: 'linux' }, {
        fs: {
          async mkdir() {},
          async lstat() {
            return directoryState(0o40750);
          },
          async chmod() {
            throw fsError('EPERM');
          },
          async access() {
            assert.fail('failed chmod must stop before access');
          },
        },
      }),
    { code: 'EPERM' },
  );
});

test('keeps an in-run config home public instead of forcing the run directory private', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'tui-lab-run-context-shared-config-'));
  try {
    const template = path.join(root, 'workspace-template');
    await mkdir(template, { recursive: true });
    const layout = await createRunContext(
      options(root),
      'run',
      runtime(root, { configRoot: undefined }),
    );
    assert.equal(layout.configHome, layout.dir);
    if (process.platform !== 'win32') {
      assert.equal((await stat(layout.dir)).mode & 0o777, 0o755);
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('rejects an outside target before making any filesystem change', async () => {
  let changed = false;
  await assert.rejects(
    () =>
      ensureTrustedDirectoryPath('/outside/run', {
        mode: 0o755,
        trustedRoot: '/trusted',
        platform: 'linux',
      }, {
        fs: {
          async mkdir() {
            changed = true;
          },
        },
      }),
    /outside trusted root/,
  );
  assert.equal(changed, false);
});

test('accepts a pre-created private 0700 output root outside the repository', async () => {
  if (process.platform === 'win32') return;
  const repo = await mkdtemp(path.join(os.tmpdir(), 'tui-lab-repo-root-'));
  const outside = await mkdtemp(path.join(os.tmpdir(), 'tui-lab-private-out-'));
  try {
    const template = path.join(repo, 'workspace-template');
    await mkdir(template, { recursive: true });
    const layout = await createRunContext(
      options(repo, { out: outside }),
      'run',
      runtime(repo),
    );
    assert.equal((await stat(outside)).mode & 0o777, 0o700);
    assert.equal((await stat(layout.dateDir)).mode & 0o777, 0o755);
  } finally {
    await rm(repo, { recursive: true, force: true });
    await rm(outside, { recursive: true, force: true });
  }
});

test('detects a parent replacement after validation and before child creation', async () => {
  if (process.platform === 'win32') return;
  const root = await mkdtemp(path.join(os.tmpdir(), 'tui-lab-parent-replace-'));
  const base = path.join(root, 'base');
  const moved = path.join(root, 'moved');
  try {
    await mkdir(base, { mode: 0o755 });
    await assert.rejects(
      () =>
        ensureTrustedDirectoryPath(path.join(base, 'child'), {
          mode: 0o755,
          trustedRoot: root,
          platform: 'linux',
        }, {
          async afterParentValidation() {
            await rename(base, moved);
            await mkdir(base, { mode: 0o755 });
          },
        }),
      /replaced while validating/,
    );
    await assert.rejects(() => stat(path.join(base, 'child')), { code: 'ENOENT' });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('detects artifact directory replacement before terminal success metadata', async () => {
  if (process.platform === 'win32') return;
  const root = await mkdtemp(path.join(os.tmpdir(), 'tui-lab-final-integrity-'));
  try {
    const template = path.join(root, 'workspace-template');
    await mkdir(template, { recursive: true });
    const testRuntime = runtime(root);
    const layout = await createRunContext(options(root), 'run', testRuntime);
    await rename(layout.dir, `${layout.dir}.replaced`);
    await mkdir(layout.dir, { mode: 0o755 });
    await assert.rejects(() => verifyRunContextIntegrity(layout, testRuntime), /replaced while validating/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('fails closed when a trusted Unix parent has an untrusted owner', async () => {
  const state = directoryState(0o40755, { uid: 99999 });
  await assert.rejects(
    () =>
      ensureTrustedDirectoryPath('/trusted', {
        mode: 0o755,
        trustedRoot: '/trusted',
        platform: 'linux',
      }, {
        uid: process.getuid?.() ?? 0,
        fs: { async lstat() { return state; } },
      }),
    /untrusted directory owner/,
  );
});

test('uses a native Windows reparse and DACL probe and fails on probe errors', () => {
  const calls = [];
  const verified = verifyWindowsDirectory('C:\\safe\\run', {
    spawnSync(command, args, options) {
      calls.push({ command, args, options });
      return { status: 0, stdout: '{"ok":true,"owner":"user"}', stderr: '' };
    },
  });
  assert.equal(verified.ok, true);
  assert.equal(calls[0].command, 'powershell.exe');
  assert.ok(calls[0].args.includes('-EncodedCommand'));
  const encoded = calls[0].args.at(-1);
  const script = Buffer.from(encoded, 'base64').toString('utf16le');
  assert.match(script, /ReparsePoint/);
  assert.match(script, /Get-Acl/);
  assert.match(script, /untrusted foreign DACL entry/);
  assert.doesNotMatch(script, /C:\\safe\\run/);
  assert.equal(calls[0].options.env.KCODER_TUI_LAB_SECURE_PATH, 'C:\\safe\\run');
  assert.throws(
    () => verifyWindowsDirectory('C:\\unsafe', {
      spawnSync: () => ({ status: 1, stdout: '', stderr: 'DACL denied' }),
    }),
    /DACL verification failed.*DACL denied/,
  );
});

test('sets and verifies a protected current-user-only Windows DACL', () => {
  const events = [];
  const result = secureWindowsPrivateDirectory('C:\\private-config', {
    windowsSecurePrivateDirectory(directory) {
      events.push(['secure', directory]);
      return { ok: true };
    },
    windowsVerifyDirectory(directory, options) {
      events.push(['verify', directory, options.privateAcl]);
      return { ok: true, protected: true };
    },
  });
  assert.equal(result.ok, true);
  assert.deepEqual(events, [
    ['secure', 'C:\\private-config'],
    ['verify', 'C:\\private-config', true],
  ]);
});

test('does not skip a failed injected Windows directory security probe', async () => {
  await assert.rejects(
    () =>
      ensureDirectory('C:\\unsafe', { mode: 0o755, platform: 'win32' }, {
        windowsVerifyDirectory: () => ({ ok: false, reason: 'reparse point rejected' }),
        fs: {
          async mkdir() {
            throw fsError('EEXIST');
          },
          async lstat() {
            return directoryState(0o40755);
          },
        },
      }),
    /reparse point rejected/,
  );
});

test('marks Windows runtime enforcement as VM-unverified unless the executable gate is set', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'tui-lab-windows-security-'));
  try {
    const template = path.join(root, 'workspace-template');
    await mkdir(template, { recursive: true });
    const windowsRuntime = runtime(root, {
      platform: 'win32',
      windowsVerifyDirectory: () => ({ ok: true }),
      windowsSecurePrivateDirectory: () => ({ ok: true }),
      windowsVmVerified: false,
    });
    const layout = await createRunContext(options(root), 'run', windowsRuntime);
    assert.deepEqual(layout.windowsSecurityVerification, {
      enforced: true,
      nativeVmVerified: false,
      coverage: 'runtime-enforced-vm-unverified',
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('prepares the OCR git baseline and leaves only the intended regression dirty', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'tui-lab-run-context-ocr-'));
  const gitCalls = [];
  try {
    const template = path.join(root, 'workspace-template');
    await mkdir(template, { recursive: true });
    await writeFile(path.join(template, 'README.md'), 'OCR fixture\n');
    const testRuntime = runtime(root, {
      spawnSync(command, args, spawnOptions) {
        gitCalls.push({ command, args: [...args], cwd: spawnOptions.cwd });
        return spawnSync(command, args, spawnOptions);
      },
    });
    const layout = await createRunContext(options(root, { scenario: 'ocr-review' }), 'ocr-review', testRuntime);
    const status = spawnSync('git', ['-C', layout.workspace, 'status', '--porcelain'], { encoding: 'utf8' });
    assert.equal(status.status, 0, status.stderr);
    assert.equal(status.stdout, ' M src/ocr_demo.py\n');
    const baseline = spawnSync('git', ['-C', layout.workspace, 'show', 'HEAD:src/ocr_demo.py'], {
      encoding: 'utf8',
    });
    assert.equal(baseline.status, 0, baseline.stderr);
    assert.match(baseline.stdout, /1 - percent \/ 100/);
    assert.match(await readFile(path.join(layout.workspace, 'src', 'ocr_demo.py'), 'utf8'), /1 \+ percent \/ 100/);
    assert.deepEqual(
      gitCalls.map(({ command, args }) => [command, args[0], args.at(-1)]),
      [
        ['git', 'init', layout.workspace],
        ['git', `--git-dir=${path.join(layout.workspace, '.git')}`, 'tui-lab@example.invalid'],
        ['git', `--git-dir=${path.join(layout.workspace, '.git')}`, 'KCoder TUI Lab'],
        ['git', `--git-dir=${path.join(layout.workspace, '.git')}`, '.'],
        ['git', `--git-dir=${path.join(layout.workspace, '.git')}`, 'baseline'],
      ],
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
