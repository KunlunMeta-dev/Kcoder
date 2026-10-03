import { spawnSync as nodeSpawnSync } from 'node:child_process';
import { constants as fsConstants, existsSync } from 'node:fs';
import { access, chmod, cp, lstat, mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { windowsRunDescription } from './platform-adapter.mjs';

const directoryFs = { access, chmod, lstat, mkdir };

function isMissing(error) {
  return error?.code === 'ENOENT';
}

function assertDirectoryState(directory, state, mode, acceptedModes = [mode]) {
  if (state.isSymbolicLink() || !state.isDirectory()) {
    throw new Error(`refusing unsafe directory path: ${directory}`);
  }
  const actualMode = state.mode & 0o777;
  if (!acceptedModes.includes(actualMode)) {
    throw new Error(
      `directory mode mismatch for ${directory}: expected ${acceptedModes.map((value) => value.toString(8)).join(' or ')}, got ${actualMode.toString(8)}`,
    );
  }
}

function assertSameDirectory(directory, before, after) {
  if (before.dev !== after.dev || before.ino !== after.ino) {
    throw new Error(`directory was replaced while validating: ${directory}`);
  }
}

function unixTrust(runtime = {}) {
  const uid = runtime.uid ?? process.getuid?.();
  return { uid };
}

function assertUnixOwnerAndPermissions(directory, state, runtime, { parent = false } = {}) {
  const { uid } = unixTrust(runtime);
  if (!Number.isInteger(uid) || state.uid !== uid) {
    throw new Error(`untrusted directory owner for ${directory}; use a directory owned by the current user`);
  }
  const mode = state.mode & 0o777;
  if ((mode & 0o022) !== 0) {
    throw new Error(
      `untrusted writable parent chain at ${directory}; choose a private, current-user-owned trusted directory`,
    );
  }
  if (parent && (mode & 0o100) === 0) {
    throw new Error(`untrusted non-searchable parent directory: ${directory}`);
  }
}

export function verifyWindowsDirectory(directory, runtime = {}) {
  if (runtime.windowsVerifyDirectory) {
    const result = runtime.windowsVerifyDirectory(directory, { privateAcl: runtime.privateAcl === true });
    if (!result?.ok) throw new Error(result?.reason || `Windows directory security check failed: ${directory}`);
    return result;
  }
  const spawnSync = runtime.spawnSync || nodeSpawnSync;
  const script = [
    '$p = $env:KCODER_TUI_LAB_SECURE_PATH',
    '$privateAcl = $env:KCODER_TUI_LAB_PRIVATE_ACL -eq "1"',
    '$item = Get-Item -LiteralPath $p -Force -ErrorAction Stop',
    "if (($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) { throw 'reparse point rejected' }",
    '$me = [Security.Principal.WindowsIdentity]::GetCurrent().User.Value',
    '$allowed = if ($privateAcl) { @($me) } else { @($me, "S-1-5-18", "S-1-5-32-544") }',
    '$acl = Get-Acl -LiteralPath $p -ErrorAction Stop',
    '$owner = $acl.Owner',
    '$ownerSid = (New-Object Security.Principal.NTAccount($owner)).Translate([Security.Principal.SecurityIdentifier]).Value',
    "if ($allowed -notcontains $ownerSid) { throw ('untrusted owner: ' + $owner) }",
    'if ($privateAcl -and (-not $acl.AreAccessRulesProtected)) { throw "private DACL inherits foreign access" }',
    '$dangerous = if ($privateAcl) { [Security.AccessControl.FileSystemRights]::FullControl } else { [Security.AccessControl.FileSystemRights]::Write -bor [Security.AccessControl.FileSystemRights]::Delete -bor [Security.AccessControl.FileSystemRights]::ChangePermissions -bor [Security.AccessControl.FileSystemRights]::TakeOwnership }',
    'foreach ($rule in $acl.Access) {',
    '  $sid = $rule.IdentityReference.Translate([Security.Principal.SecurityIdentifier]).Value',
    '  if ($rule.AccessControlType -eq "Allow" -and (($rule.FileSystemRights -band $dangerous) -ne 0) -and ($allowed -notcontains $sid)) { throw ("untrusted foreign DACL entry: " + $sid) }',
    '}',
    '@{ ok = $true; owner = $owner; ownerSid = $ownerSid } | ConvertTo-Json -Compress',
  ].join('\n');
  const encoded = Buffer.from(script, 'utf16le').toString('base64');
  const result = spawnSync('powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand', encoded], {
    encoding: 'utf8',
    windowsHide: true,
    timeout: 10000,
    env: {
      ...process.env,
      KCODER_TUI_LAB_SECURE_PATH: directory,
      KCODER_TUI_LAB_PRIVATE_ACL: runtime.privateAcl === true ? '1' : '0',
    },
  });
  if (result.status !== 0) {
    throw new Error(`Windows reparse/DACL verification failed for ${directory}: ${result.stderr || result.error || 'unknown error'}`);
  }
  try {
    const parsed = JSON.parse(result.stdout);
    if (parsed.ok !== true) throw new Error('native verifier did not return ok');
    return parsed;
  } catch (error) {
    throw new Error(`Windows reparse/DACL verifier returned invalid output for ${directory}: ${error.message}`);
  }
}

export function secureWindowsPrivateDirectory(directory, runtime = {}) {
  if (runtime.windowsSecurePrivateDirectory) {
    const result = runtime.windowsSecurePrivateDirectory(directory);
    if (!result?.ok) throw new Error(result?.reason || `failed to secure private Windows directory: ${directory}`);
  } else {
    const spawnSync = runtime.spawnSync || nodeSpawnSync;
    const script = [
      '$p = $env:KCODER_TUI_LAB_SECURE_PATH',
      '$identity = [Security.Principal.WindowsIdentity]::GetCurrent()',
      '$security = New-Object Security.AccessControl.DirectorySecurity',
      '$security.SetOwner($identity.User)',
      '$security.SetAccessRuleProtection($true, $false)',
      '$inherit = [Security.AccessControl.InheritanceFlags]::ContainerInherit -bor [Security.AccessControl.InheritanceFlags]::ObjectInherit',
      '$rule = New-Object Security.AccessControl.FileSystemAccessRule($identity.User, "FullControl", $inherit, "None", "Allow")',
      '$security.AddAccessRule($rule)',
      'Set-Acl -LiteralPath $p -AclObject $security -ErrorAction Stop',
    ].join('\n');
    const encoded = Buffer.from(script, 'utf16le').toString('base64');
    const result = spawnSync('powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand', encoded], {
      encoding: 'utf8',
      windowsHide: true,
      timeout: 10000,
      env: { ...process.env, KCODER_TUI_LAB_SECURE_PATH: directory },
    });
    if (result.status !== 0) {
      throw new Error(`failed to set protected current-user-only DACL for ${directory}: ${result.stderr || result.error || 'unknown error'}`);
    }
  }
  return verifyWindowsDirectory(directory, { ...runtime, privateAcl: true });
}

export async function ensureDirectory(
  directory,
  { mode, acceptedModes = [mode], mustCreate = false, platform = process.platform },
  runtime = {},
) {
  const fs = { ...directoryFs, ...runtime.fs };
  let created = false;

  try {
    await fs.mkdir(directory, { recursive: false, mode });
    created = true;
  } catch (error) {
    if (error?.code !== 'EEXIST' || mustCreate) throw error;
  }

  let state = await fs.lstat(directory);
  if (state.isSymbolicLink() || !state.isDirectory()) {
    throw new Error(`refusing unsafe directory path: ${directory}`);
  }

  if (platform !== 'win32') {
    assertUnixOwnerAndPermissions(directory, state, runtime);
    const actualMode = state.mode & 0o777;
    if (!created && actualMode !== mode) {
      assertDirectoryState(directory, state, mode, acceptedModes);
    }
    if (created && actualMode !== mode) {
      const before = state;
      await fs.chmod(directory, mode);
      state = await fs.lstat(directory);
      assertSameDirectory(directory, before, state);
      assertDirectoryState(directory, state, mode);
    } else {
      assertDirectoryState(directory, state, mode, created ? [mode] : acceptedModes);
    }

    const beforeAccess = state;
    await fs.access(directory, fsConstants.W_OK | fsConstants.X_OK);
    state = await fs.lstat(directory);
    assertSameDirectory(directory, beforeAccess, state);
    assertDirectoryState(directory, state, mode, created ? [mode] : acceptedModes);
    assertUnixOwnerAndPermissions(directory, state, runtime);
  } else {
    verifyWindowsDirectory(directory, runtime);
    const afterVerification = await fs.lstat(directory);
    assertSameDirectory(directory, state, afterVerification);
    if (afterVerification.isSymbolicLink() || !afterVerification.isDirectory()) {
      throw new Error(`refusing unsafe Windows directory path: ${directory}`);
    }
  }

  return { created, state };
}

export async function ensureTrustedDirectoryPath(
  directory,
  { mode, acceptedModes = [mode], intermediateMode = 0o755, trustedRoot, platform = process.platform },
  runtime = {},
) {
  const fs = { ...directoryFs, ...runtime.fs };
  const target = path.resolve(directory);
  const root = path.resolve(trustedRoot);
  const relative = path.relative(root, target);
  if (relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new Error(
      `output directory ${target} is outside trusted root ${root}; pre-create a private directory and select it as the trusted output root`,
    );
  }
  const paths = [root];
  if (relative) {
    let current = root;
    for (const segment of relative.split(path.sep)) {
      current = path.join(current, segment);
      paths.push(current);
    }
  }

  const existing = [];
  let missing = false;
  for (const candidate of paths) {
    if (missing) continue;
    try {
      const state = await fs.lstat(candidate);
      if (state.isSymbolicLink() || !state.isDirectory()) {
        throw new Error(`refusing unsafe parent chain entry: ${candidate}`);
      }
      if (platform === 'win32') verifyWindowsDirectory(candidate, runtime);
      else assertUnixOwnerAndPermissions(candidate, state, runtime, { parent: true });
      existing.push({ candidate, state });
    } catch (error) {
      if (!isMissing(error)) throw error;
      missing = true;
    }
  }

  await runtime.afterParentValidation?.({ target, existing: existing.map(({ candidate }) => candidate) });
  for (const { candidate, state } of existing) {
    const current = await fs.lstat(candidate);
    assertSameDirectory(candidate, state, current);
  }

  for (let index = existing.length; index < paths.length; index += 1) {
    const candidate = paths[index];
    await ensureDirectory(
      candidate,
      { mode: index === paths.length - 1 ? mode : intermediateMode, mustCreate: true, platform },
      runtime,
    );
  }
  if (existing.length === paths.length) {
    await ensureDirectory(target, { mode, acceptedModes, platform }, runtime);
  }
  return fs.lstat(target);
}

function runTimestampParts(date) {
  const pad = (value, width = 2) => String(value).padStart(width, '0');
  const year = date.getFullYear();
  const month = pad(date.getMonth() + 1);
  const day = pad(date.getDate());
  const hour = pad(date.getHours());
  const minute = pad(date.getMinutes());
  const second = pad(date.getSeconds());
  const millis = pad(date.getMilliseconds(), 3);
  return {
    dateStamp: `${year}-${month}-${day}`,
    timeStamp: `${hour}-${minute}-${second}-${millis}`,
  };
}

function sanitizePathSegment(value) {
  const text = String(value || 'run')
    .normalize('NFKC')
    .trim()
    .replace(/[\\/:\s]+/g, '-')
    .replace(/[^\p{L}\p{N}._-]+/gu, '-')
    .replace(/-+/g, '-')
    .replace(/^[-.]+|[-.]+$/g, '');
  return text || 'run';
}

function projectKeyForPath(value) {
  return path.resolve(value).replace(/[\\/:\s]/g, '_');
}

export function materializeRunContext(options, prefix, runtime) {
  const { dateStamp, timeStamp } = runTimestampParts(runtime.now);
  const description = sanitizePathSegment(
    windowsRunDescription(options.description || `${prefix}-${options.scenario}`, runtime.platform),
  );
  const runLabel = `${timeStamp}-${description}-${runtime.pid}`;
  const runId = `${dateStamp}/${runLabel}`;
  const base = options.out || runtime.targetRoot;
  const baseDir = path.isAbsolute(base) ? base : path.resolve(runtime.cwd, base);
  const dateDir = path.join(baseDir, dateStamp);
  const dir = path.join(dateDir, runLabel);
  const workspace = path.join(dir, 'workspace');
  const template = path.isAbsolute(options.workspaceTemplate)
    ? options.workspaceTemplate
    : path.resolve(runtime.cwd, options.workspaceTemplate);
  const configHome = runtime.configRoot
    ? path.join(runtime.configRoot, dateStamp, runLabel)
    : dir;
  const configDir = path.join(configHome, 'kcoder');
  const projectKey = projectKeyForPath(workspace);
  const projectDir = path.join(configDir, 'projects', projectKey);
  const artifact = (name) => path.join(dir, name);

  return {
    runId,
    dateStamp,
    timeStamp,
    description,
    baseDir,
    dateDir,
    runLabel,
    dir,
    workspace,
    workspaceTemplate: template,
    configHome,
    configDir,
    projectKey,
    projectDir,
    welcomeScreenshot: artifact('01-welcome.png'),
    afterEnterScreenshot: artifact('after-enter.png'),
    streamingScreenshot: artifact('streaming.png'),
    afterToolScreenshot: artifact('after-tool.png'),
    afterToolExpandedScreenshot: artifact('after-tool-expanded.png'),
    finalScreenshot: artifact('after-final.png'),
    streamingScrollbarBeforeDragScreenshot: artifact('streaming-scrollbar-before-drag.png'),
    streamingScrollbarTopScreenshot: artifact('streaming-scrollbar-top.png'),
    streamingScrollbarBottomScreenshot: artifact('streaming-scrollbar-bottom.png'),
    afterReleaseMouseMoveScreenshot: artifact('after-release-mouse-move.png'),
    afterScrollbarDragBottomScreenshot: artifact('after-scrollbar-drag-bottom.png'),
    afterScrollTopScreenshot: artifact('after-scroll-top.png'),
    afterScrollBottomScreenshot: artifact('after-scroll-bottom.png'),
    afterSecondMessageScreenshot: artifact('after-second-message.png'),
    afterSecondFinalScreenshot: artifact('after-second-final.png'),
    imagePasteComposedScreenshot: artifact('image-paste-composed.png'),
    imagePasteSubmittedScreenshot: artifact('image-paste-submitted.png'),
    scrolledScreenshot: artifact('after-scroll-top.png'),
    screenshot: artifact('after-scroll-top.png'),
    text: artifact('screen.txt'),
    ansiText: artifact('screen.ansi.txt'),
    ptyLog: artifact('pty.log'),
    browserConsoleLog: artifact('browser-console.log'),
    startMeta: artifact('meta.start.json'),
    meta: artifact('meta.json'),
    assertions: artifact('assertions.json'),
    requestsDir: artifact('requests'),
    failure: artifact('failure.json'),
    failureScreenshot: artifact('failure.png'),
    recordingRaw: artifact('recording.raw.webm'),
    recordingVideo: artifact('recording.mp4'),
    recordingTimeline: artifact('recording.timeline.json'),
    recordingSamplesDir: artifact('recording-samples'),
    recordingFramesDir: artifact('recording-video-frames'),
  };
}

export async function createRunContext(options, prefix = 'run', runtime) {
  const layout = materializeRunContext(options, prefix, runtime);

  if (!existsSync(layout.workspaceTemplate)) {
    throw new Error(`workspace template does not exist: ${layout.workspaceTemplate}`);
  }

  const trustedRuntime = {
    ...runtime,
    fs: runtime.fs,
  };
  const baseResult = await ensureDirectory(
    layout.baseDir,
    { mode: 0o755, acceptedModes: [0o755, 0o700], platform: runtime.platform },
    trustedRuntime,
  );
  const baseState = baseResult.state;
  const dateResult = await ensureDirectory(
    layout.dateDir,
    { mode: 0o755, platform: runtime.platform },
    trustedRuntime,
  );
  const fs = { ...directoryFs, ...runtime.fs };
  assertSameDirectory(layout.baseDir, baseState, await fs.lstat(layout.baseDir));
  const runResult = await ensureDirectory(
    layout.dir,
    { mode: 0o755, mustCreate: true, platform: runtime.platform },
    trustedRuntime,
  );
  await cp(layout.workspaceTemplate, layout.workspace, {
    recursive: true,
    errorOnExist: true,
    force: false,
  });
  if (options.scenario === 'ocr-review') {
    await prepareOcrReviewWorkspace(layout.workspace, runtime);
  }
  if (layout.configHome !== layout.dir) {
    const configTrustedRoot = runtime.configTrustRoot || runtime.configRoot;
    if (!configTrustedRoot) {
      throw new Error(
        `config directory ${layout.configHome} has no explicit private trust root`,
      );
    }
    await ensureTrustedDirectoryPath(
      layout.configHome,
      { mode: 0o700, intermediateMode: 0o700, trustedRoot: configTrustedRoot, platform: runtime.platform },
      trustedRuntime,
    );
  }
  if (runtime.platform === 'win32') {
    secureWindowsPrivateDirectory(layout.configHome, trustedRuntime);
    layout.windowsSecurityVerification = {
      enforced: true,
      nativeVmVerified: runtime.windowsVmVerified === true,
      coverage: runtime.windowsVmVerified === true ? 'native-vm-verified' : 'runtime-enforced-vm-unverified',
    };
  }
  Object.defineProperty(layout, 'directoryIdentities', {
    enumerable: false,
    value: {
      baseDir: baseState,
      dateDir: dateResult.state,
      dir: runResult.state,
    },
  });
  return layout;
}

export async function verifyRunContextIntegrity(layout, runtime = {}) {
  const fs = { ...directoryFs, ...runtime.fs };
  if (!layout.directoryIdentities) throw new Error('run context has no captured directory identities');
  for (const name of ['baseDir', 'dateDir', 'dir']) {
    const directory = layout[name];
    const current = await fs.lstat(directory);
    assertSameDirectory(directory, layout.directoryIdentities[name], current);
    if (current.isSymbolicLink() || !current.isDirectory()) {
      throw new Error(`run artifact directory became unsafe: ${directory}`);
    }
    if ((current.mode & 0o022) !== 0 && runtime.platform !== 'win32') {
      throw new Error(`run artifact directory became writable by another principal: ${directory}`);
    }
  }
  return true;
}

async function prepareOcrReviewWorkspace(workspace, runtime) {
  const srcDir = path.join(workspace, 'src');
  const demoFile = path.join(srcDir, 'ocr_demo.py');
  await mkdir(srcDir, { recursive: true });
  await writeTextFile(
    demoFile,
    [
      'def discount(price: float, percent: float) -> float:',
      '    """Return price after applying a percentage discount."""',
      '    return price * (1 - percent / 100)',
      '',
      '',
      'def format_total(price: float, percent: float) -> str:',
      '    return f"${discount(price, percent):.2f}"',
      '',
    ].join('\n'),
  );
  runGit(workspace, ['init'], runtime);
  runGit(workspace, ['config', 'user.email', 'tui-lab@example.invalid'], runtime);
  runGit(workspace, ['config', 'user.name', 'KCoder TUI Lab'], runtime);
  runGit(workspace, ['add', '.'], runtime);
  runGit(workspace, ['commit', '-m', 'baseline'], runtime);
  await writeTextFile(
    demoFile,
    [
      'def discount(price: float, percent: float) -> float:',
      '    """Return price after applying a percentage discount."""',
      '    # Intentional demo regression: percent is added instead of subtracted.',
      '    return price * (1 + percent / 100)',
      '',
      '',
      'def format_total(price: float, percent: float) -> str:',
      '    return f"${discount(price, percent):.2f}"',
      '',
    ].join('\n'),
  );
}

function runGit(cwd, args, runtime) {
  const commandArgs =
    args[0] === 'init' ? ['init', cwd] : [`--git-dir=${path.join(cwd, '.git')}`, `--work-tree=${cwd}`, ...args];
  const spawnSync = runtime.spawnSync || nodeSpawnSync;
  const result = spawnSync('git', commandArgs, {
    cwd: runtime.repoRoot,
    encoding: 'utf8',
  });
  if (result.status !== 0) {
    throw new Error(
      `git ${commandArgs.join(' ')} failed for ${cwd}: ${result.stderr || result.stdout || result.error}`,
    );
  }
}

async function writeTextFile(file, content) {
  await writeFile(file, content, { mode: 0o644 });
  await chmod(file, 0o644);
}
