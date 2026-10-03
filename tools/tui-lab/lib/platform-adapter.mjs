import path from 'node:path';

export function quoteForPlatform(value, platform = process.platform) {
  const text = String(value);
  if (platform === 'win32') {
    return `'${text.replaceAll("'", "''")}'`;
  }
  return `'${text.replaceAll("'", "'\\''")}'`;
}

export function expandCommandTemplateForPlatform(command, values, platform = process.platform) {
  const replacements = {
    '{workspace}': values.workspace || '',
    '{runDir}': values.runDir || '',
    '{repoRoot}': values.repoRoot || '',
  };
  const startsWithPlaceholderPath =
    /^\s*\{(?:workspace|runDir|repoRoot)\}(?:[\\/][^\s;|&<>()"'`]*)?/.test(command);
  const pathApi = platform === 'win32' ? path.win32 : path.posix;
  let expanded = command.replace(
    /(\{workspace\}|\{runDir\}|\{repoRoot\})((?:[\\/][^\s;|&<>()"'`]*)?)/g,
    (_match, placeholder, suffix) => {
      const base = replacements[placeholder];
      const segments = suffix.split(/[\\/]+/).filter(Boolean);
      const value = segments.length > 0 ? pathApi.join(base, ...segments) : base;
      return quoteForPlatform(value, platform);
    },
  );
  if (platform === 'win32' && startsWithPlaceholderPath) {
    const leadingWhitespace = expanded.match(/^\s*/)?.[0] || '';
    expanded = `${leadingWhitespace}& ${expanded.slice(leadingWhitespace.length)}`;
  }
  return expanded;
}

export function platformShell(platform = process.platform, env = process.env) {
  if (platform === 'win32') {
    return {
      file: env.KCODER_TUI_LAB_POWERSHELL || 'powershell.exe',
      commandArgs: ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command'],
    };
  }
  return {
    file: env.SHELL || 'bash',
    commandArgs: ['-lc'],
  };
}

export function delayedSpawn(file, args, delaySeconds, platform = process.platform, env = process.env) {
  const shell = platformShell(platform, env);
  const command = [file, ...args].map((value) => quoteForPlatform(value, platform)).join(' ');
  if (platform === 'win32') {
    const milliseconds = Math.max(0, Math.round(delaySeconds * 1000));
    return {
      file: shell.file,
      args: [...shell.commandArgs, `Start-Sleep -Milliseconds ${milliseconds}; & ${command}`],
    };
  }
  return {
    file: shell.file,
    args: [...shell.commandArgs, `sleep ${delaySeconds}; exec ${command}`],
  };
}

export function configEnvironment(configHome, platform = process.platform) {
  if (!configHome) return {};
  if (platform === 'win32') {
    return {
      KCODER_CONFIG_DIR: path.win32.join(configHome, 'kcoder'),
      APPDATA: configHome,
      LOCALAPPDATA: path.win32.join(configHome, 'LocalAppData'),
    };
  }
  return {
    KCODER_CONFIG_DIR: path.posix.join(configHome, 'kcoder'),
    XDG_CONFIG_HOME: configHome,
  };
}

export function assertModeSupported(mode, platform = process.platform) {
  if (platform === 'win32' && mode.startsWith('tmux-')) {
    throw new Error(`${mode} uses tmux and is not supported on Windows; use resize-visual instead`);
  }
}

export function platformDescription(platform = process.platform, env = process.env) {
  return {
    platform,
    os: env.KCODER_TUI_LAB_OS || (platform === 'win32' ? 'Windows' : process.platform),
    pty: platform === 'win32' ? 'ConPTY' : 'PTY',
    architecture: env.KCODER_TUI_LAB_ARCHITECTURE || process.arch,
    rustToolchain: env.KCODER_TUI_LAB_RUST_TOOLCHAIN || undefined,
    cargoTargetDir: env.KCODER_TUI_LAB_CARGO_TARGET_DIR || undefined,
    repoId: env.KCODER_TUI_LAB_REPO_ID || undefined,
  };
}

export function windowsRunDescription(description, platform = process.platform) {
  if (platform !== 'win32') return description;
  const prefix = 'windows-server-2022-';
  return description.startsWith(prefix) ? description : `${prefix}${description}`;
}

export function terminalPreambleForPlatform(platform = process.platform, mode = 'single') {
  if (platform !== 'win32') return '';
  if (mode === 'inline') return '';
  // Crossterm uses Windows console APIs for the alternate screen and mouse
  // input. ConPTY consumes those mode changes instead of echoing their DECSET
  // sequences to a web terminal client. Real Windows hosts bridge the console
  // modes; tui-lab mirrors that bridge explicitly for xterm.js.
  return '\x1b[?1049h\x1b[?1000h\x1b[?1002h\x1b[?1003h\x1b[?1015h\x1b[?1006h';
}

export function interactionBudgetsForPlatform(platform = process.platform) {
  if (platform === 'win32') {
    return {
      rapidPageMs: 700,
      fullPageMs: 2500,
      wheelBoundMs: 10000,
      scrollbarDragMs: 500,
      sustainedWheelDelta: 120,
      sustainedDirectionPeriodMs: 2500,
    };
  }
  return {
    rapidPageMs: 700,
    fullPageMs: 4000,
    wheelBoundMs: 10000,
    scrollbarDragMs: 300,
    sustainedWheelDelta: 720,
    sustainedDirectionPeriodMs: null,
  };
}

// node-pty's Windows kill helper attaches to the child's console to enumerate
// the process tree. If ConPTY misses an exit event, that helper can race an
// already-disappearing shell and hang in AttachConsole. Node's process.kill
// uses the direct process handle path and is safe for this final fallback.
export function terminateProcessWithoutConsoleAttach(pid, signaler = process.kill) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    signaler(pid);
    return true;
  } catch {
    return false;
  }
}

// Cleanup is best-effort after artifacts have been flushed. Playwright or
// ConPTY may leave an unresolved close promise on Windows, so never let that
// keep an SSH/CI operation alive indefinitely.
export async function settleWithin(promise, timeoutMs = 5000) {
  const boundedTimeoutMs = Math.max(0, Number.isFinite(timeoutMs) ? timeoutMs : 5000);
  let timer;
  return new Promise((resolve) => {
    const finish = (completed) => {
      if (timer) clearTimeout(timer);
      resolve(completed);
    };
    timer = setTimeout(() => finish(false), boundedTimeoutMs);
    Promise.resolve(promise).then(
      () => finish(true),
      () => finish(true),
    );
  });
}

export async function requestGracefulPtyStop(
  ptyProcess,
  exitPromise,
  isExited,
  platform = process.platform,
  timeoutMs = 1500,
) {
  if (isExited()) return true;
  if (platform !== 'win32') return false;

  try {
    ptyProcess.write('\x03');
  } catch {
    return false;
  }

  const exitedAfterInterrupt = await Promise.race([
    exitPromise.then(() => true),
    new Promise((resolve) => setTimeout(() => resolve(false), Math.min(timeoutMs, 150))),
  ]);
  if (exitedAfterInterrupt || isExited()) return true;

  try {
    // Ctrl+U clears any partially entered prompt before using the REPL's exit alias.
    ptyProcess.write('\x15/exit\r');
  } catch {
    return false;
  }
  const exitedAfterCommand = await Promise.race([
    exitPromise.then(() => true),
    new Promise((resolve) => setTimeout(() => resolve(false), timeoutMs)),
  ]);
  if (exitedAfterCommand || isExited()) return true;

  // ConPTY can report process exit just after the REPL has accepted /exit.
  // Give that event a small final grace period before node-pty falls back to
  // its AttachConsole-based kill helper, which races a process that is already
  // disappearing and emits a misleading stack trace.
  const finalExitGraceMs = Math.min(Math.max(Math.floor(timeoutMs / 3), 50), 500);
  const exitedDuringGrace = await Promise.race([
    exitPromise.then(() => true),
    new Promise((resolve) => setTimeout(() => resolve(false), finalExitGraceMs)),
  ]);
  return exitedDuringGrace || isExited();
}
