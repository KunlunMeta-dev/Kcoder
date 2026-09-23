import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import {
  assertModeSupported,
  configEnvironment,
  delayedSpawn,
  expandCommandTemplateForPlatform,
  interactionBudgetsForPlatform,
  platformDescription,
  platformShell,
  quoteForPlatform,
  requestGracefulPtyStop,
  settleWithin,
  terminalPreambleForPlatform,
  terminateProcessWithoutConsoleAttach,
  windowsRunDescription,
} from '../lib/platform-adapter.mjs';

test('quotes apostrophes for PowerShell without POSIX escapes', () => {
  assert.equal(quoteForPlatform("C:\\O'Brien", 'win32'), "'C:\\O''Brien'");
  assert.equal(quoteForPlatform("O'Brien", 'linux'), "'O'\\''Brien'");
});

test('expands Windows placeholders with PowerShell-safe paths', () => {
  const expanded = expandCommandTemplateForPlatform(
    '& {repoRoot} --cwd {workspace}',
    { repoRoot: 'Z:\\KCoder', workspace: "Z:\\Runs\\O'Brien", runDir: 'Z:\\run' },
    'win32',
  );
  assert.equal(
    expanded,
    "& 'Z:\\KCoder' --cwd 'Z:\\Runs\\O''Brien'",
  );
});

test('expands a Windows placeholder plus path suffix as one executable argument', () => {
  const expanded = expandCommandTemplateForPlatform(
    '{repoRoot}/target/release/kcoder.exe --cwd {workspace} tui-dev --scenario full-turn',
    { repoRoot: 'Z:\\KCoder', workspace: "Z:\\Runs\\O'Brien", runDir: 'Z:\\run' },
    'win32',
  );
  assert.equal(
    expanded,
    "& 'Z:\\KCoder\\target\\release\\kcoder.exe' --cwd 'Z:\\Runs\\O''Brien' tui-dev --scenario full-turn",
  );
});

test('preserves attached Windows placeholders and adjacent PowerShell operators', () => {
  const values = {
    repoRoot: 'Z:\\KCoder',
    workspace: "Z:\\Runs\\O'Brien",
    runDir: 'Z:\\run',
  };
  assert.equal(
    expandCommandTemplateForPlatform(
      'tool --cwd={workspace} --out={runDir}/out.txt',
      values,
      'win32',
    ),
    "tool --cwd='Z:\\Runs\\O''Brien' --out='Z:\\run\\out.txt'",
  );
  assert.equal(
    expandCommandTemplateForPlatform(
      '{repoRoot}/bin/tool.exe|Write-Output ok;Write-Output done',
      values,
      'win32',
    ),
    "& 'Z:\\KCoder\\bin\\tool.exe'|Write-Output ok;Write-Output done",
  );
});

test('selects PowerShell and run-local Windows config variables', () => {
  assert.deepEqual(platformShell('win32', { KCODER_TUI_LAB_POWERSHELL: 'pwsh.exe' }), {
    file: 'pwsh.exe',
    commandArgs: ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command'],
  });
  assert.deepEqual(configEnvironment('C:\\run', 'win32'), {
    KCODER_CONFIG_DIR: 'C:\\run\\kcoder',
    APPDATA: 'C:\\run',
    LOCALAPPDATA: 'C:\\run\\LocalAppData',
  });
});

test('sets the unified KCoder config directory on Unix', () => {
  assert.deepEqual(configEnvironment('/tmp/run', 'linux'), {
    KCODER_CONFIG_DIR: '/tmp/run/kcoder',
    XDG_CONFIG_HOME: '/tmp/run',
  });
});

test('builds delayed launches with PowerShell on Windows', () => {
  assert.deepEqual(
    delayedSpawn('C:\\bin\\kcoder.exe', ['--cwd', "C:\\O'Brien"], 0.7, 'win32', {
      KCODER_TUI_LAB_POWERSHELL: 'pwsh.exe',
    }),
    {
      file: 'pwsh.exe',
      args: [
        '-NoLogo',
        '-NoProfile',
        '-NonInteractive',
        '-Command',
        "Start-Sleep -Milliseconds 700; & 'C:\\bin\\kcoder.exe' '--cwd' 'C:\\O''Brien'",
      ],
    },
  );
});

test('rejects tmux modes on Windows and labels Windows metadata', () => {
  assert.throws(() => assertModeSupported('tmux-smoke', 'win32'), /tmux.*not supported/i);
  assert.doesNotThrow(() => assertModeSupported('run', 'win32'));
  const platform = platformDescription('win32', {
    KCODER_TUI_LAB_OS: 'Windows Server 2022',
    KCODER_TUI_LAB_ARCHITECTURE: 'AMD64',
    KCODER_TUI_LAB_RUST_TOOLCHAIN: 'stable-x86_64-pc-windows-msvc',
    KCODER_TUI_LAB_CARGO_TARGET_DIR: 'C:\\kcoder-build\\abc\\target',
    KCODER_TUI_LAB_REPO_ID: '0123456789ab',
  });
  assert.equal(platform.os, 'Windows Server 2022');
  assert.equal(platform.architecture, 'AMD64');
  assert.equal(platform.rustToolchain, 'stable-x86_64-pc-windows-msvc');
  assert.equal(platform.cargoTargetDir, 'C:\\kcoder-build\\abc\\target');
  assert.equal(platform.repoId, '0123456789ab');
  assert.equal(windowsRunDescription('quick-welcome', 'win32'), 'windows-server-2022-quick-welcome');
  assert.equal(windowsRunDescription('quick-welcome', 'linux'), 'quick-welcome');
});

test('gracefully stops ConPTY with Ctrl+C before falling back to node-pty kill', async () => {
  let exited = false;
  let resolveExit;
  const exitPromise = new Promise((resolve) => {
    resolveExit = resolve;
  });
  const writes = [];
  const stopped = await requestGracefulPtyStop(
    {
      write(data) {
        writes.push(data);
        exited = true;
        resolveExit();
      },
    },
    exitPromise,
    () => exited,
    'win32',
    20,
  );
  assert.equal(stopped, true);
  assert.deepEqual(writes, ['\x03']);
});

test('does not inject Ctrl+C into Unix PTYs during normal cleanup', async () => {
  let wrote = false;
  const stopped = await requestGracefulPtyStop(
    { write() { wrote = true; } },
    Promise.resolve(),
    () => false,
    'linux',
    1,
  );
  assert.equal(stopped, false);
  assert.equal(wrote, false);
});

test('uses the REPL exit command when Ctrl+C only cancels the active Windows turn', async () => {
  let exited = false;
  let resolveExit;
  const exitPromise = new Promise((resolve) => {
    resolveExit = resolve;
  });
  const writes = [];
  const stopped = await requestGracefulPtyStop(
    {
      write(data) {
        writes.push(data);
        if (data.includes('/exit')) {
          exited = true;
          resolveExit();
        }
      },
    },
    exitPromise,
    () => exited,
    'win32',
    20,
  );
  assert.equal(stopped, true);
  assert.deepEqual(writes, ['\x03', '\x15/exit\r']);
});

test('waits for a delayed ConPTY exit event before falling back to kill', async () => {
  let exited = false;
  let resolveExit;
  const exitPromise = new Promise((resolve) => {
    resolveExit = resolve;
  });
  const stopped = await requestGracefulPtyStop(
    {
      write(data) {
        if (data.includes('/exit')) {
          setTimeout(() => {
            exited = true;
            resolveExit();
          }, 30);
        }
      },
    },
    exitPromise,
    () => exited,
    'win32',
    20,
  );
  assert.equal(stopped, true);
});

test('bridges Windows console screen and mouse modes to the xterm.js frontend', () => {
  const preamble = terminalPreambleForPlatform('win32');
  assert.match(preamble, /^\x1b\[\?1049h/);
  assert.match(preamble, /\x1b\[\?1000h/);
  assert.match(preamble, /\x1b\[\?1003h/);
  assert.match(preamble, /\x1b\[\?1006h/);
  assert.equal(terminalPreambleForPlatform('linux'), '');
});

test('does not force the Windows alternate screen for inline TUI runs', () => {
  assert.equal(terminalPreambleForPlatform('win32', 'inline'), '');
});

test('uses bounded ConPTY interaction budgets without weakening Unix checks', () => {
  const windows = interactionBudgetsForPlatform('win32');
  const linux = interactionBudgetsForPlatform('linux');
  assert.equal(windows.rapidPageMs, 700);
  assert.equal(windows.fullPageMs, 2500);
  assert.equal(windows.wheelBoundMs, 10000);
  assert.equal(windows.scrollbarDragMs, 500);
  assert.equal(windows.sustainedWheelDelta, 120);
  assert.equal(windows.sustainedDirectionPeriodMs, 2500);
  assert.equal(linux.rapidPageMs, 700);
  assert.equal(linux.fullPageMs, 4000);
  assert.equal(linux.wheelBoundMs, 10000);
  assert.equal(linux.scrollbarDragMs, 300);
  assert.equal(linux.sustainedWheelDelta, 720);
  assert.equal(linux.sustainedDirectionPeriodMs, null);
});

test('terminates a Windows PTY shell without invoking node-pty console attachment', () => {
  const terminated = [];
  assert.equal(terminateProcessWithoutConsoleAttach(42, (pid) => terminated.push(pid)), true);
  assert.deepEqual(terminated, [42]);
  assert.equal(
    terminateProcessWithoutConsoleAttach(0, () => assert.fail('invalid pids must not be signalled')),
    false,
  );
  assert.equal(
    terminateProcessWithoutConsoleAttach(42, () => {
      throw new Error('ESRCH');
    }),
    false,
  );
});

test('bounds best-effort asynchronous cleanup', async () => {
  assert.equal(await settleWithin(Promise.resolve(), 20), true);
  assert.equal(await settleWithin(Promise.reject(new Error('cleanup failed')), 20), true);
  assert.equal(await settleWithin(new Promise(() => {}), 5), false);
});

test('the real tui-lab runner delegates platform behavior to the adapter', async () => {
  const runnerEntry = await readFile(new URL('../bin/tui-lab.mjs', import.meta.url), 'utf8');
  const runnerOptions = await readFile(new URL('../lib/runner-options.mjs', import.meta.url), 'utf8');
  const delegatedModules = await Promise.all(
    [
      'assertions.mjs',
      'browser-lifecycle.mjs',
      'failure-artifact.mjs',
      'run-context.mjs',
      'scroll-metrics.mjs',
      'session-memory-evidence.mjs',
      'terminal-interaction.mjs',
      'terminal-page.mjs',
    ].map((name) => readFile(new URL(`../lib/${name}`, import.meta.url), 'utf8')),
  );
  const runner = [runnerEntry, ...delegatedModules].join('\n');
  assert.match(runner, /from ['"]\.\.\/lib\/platform-adapter\.mjs['"]/);
  assert.match(runner, /from ['"]\.\.\/lib\/runner-options\.mjs['"]/);
  assert.match(runnerOptions, /quoteForPlatform\(value, runtime\.platform \|\| process\.platform\)/);
  assert.match(runner, /configEnvironment\(configHome, process\.platform\)/);
  assert.match(runner, /assertModeSupported\(options\.command, process\.platform\)/);
  assert.match(runner, /KCODER_TUI_LAB_INTERACTION_TIMEOUT_MS/);
  assert.match(runner, /runBrowserScenario\(options, ['"]screenshot['"], ['"]screenshot['"]\)/);
  assert.match(runner, /runBrowserScenario\(options, ['"]inline['"], ['"]inline['"]\)/);
  assert.match(runner, /['"]inline-surface-omits-committed-scrollbar['"]/);
  assert.match(runner, /['"]inline-surface-uses-host-scrollback['"]/);
  assert.match(runner, /process\.platform === ['"]win32['"]\) process\.exit\(0\)/);
  assert.match(runner, /terminateProcessWithoutConsoleAttach\(\s*ptyProcess\.pid,?\s*\)/);
  assert.match(runner, /settleWithin\(session\.stop\(\), 5000\)/);
  assert.match(runner, /await page\.evaluate\(\(\) => window\.tuiLab\.focus\(\)\)/);
  assert.match(runner, /['"]tool-expansion-applied['"]/);
  assert.match(runner, /scrollbarPixelGeometry\(geometry, scrollbar\)/);
  assert.match(runner, /buffer\.getLine\(viewportY \+ row\)/);
  assert.match(runner, /workspace: selectedWorkspace,/);
  assert.match(runner, /artifactWorkspace: artifacts\.workspace,/);
  assert.match(runner, /runBrowserScenario\(options, ['"]clipboard['"], ['"]clipboard['"]\)/);
  assert.match(runner, /Copied last message to clipboard/);
  assert.match(runner, /native-terminal-selection-is-nonempty/);
  assert.match(runner, /ctrl-c-with-native-selection-does-not-reach-tui/);
  assert.match(runner, /ctrl-c-without-selection-reaches-tui/);
  assert.match(runner, /first-idle-ctrl-c-shows-quit-hint/);
  assert.match(runner, /term\.attachCustomKeyEventHandler/);
  assert.match(runner, /term\.hasSelection\(\)/);
  assert.match(runner, /page\.keyboard\.press\(['"]Control\+C['"]\)/);
  assert.match(runner, /overwriteWindowsClipboardForTest/);
  assert.match(runner, /page\.keyboard\.press\(['"]Control\+O['"]\)/);
  assert.match(runner, /page\.keyboard\.press\(['"]Alt\+R['"]\)/);
  assert.match(runner, /runBrowserScenario\(options, ['"]history-search['"], ['"]history-search['"]\)/);
  assert.match(runner, /runBrowserScenario\(options, ['"]mention['"], ['"]mention['"]\)/);
  assert.match(runner, /runBrowserScenario\(options, ['"]paste['"], ['"]paste['"]\)/);
  assert.match(runner, /page\.keyboard\.press\(['"]Control\+R['"]\)/);
  assert.match(runner, /page\.keyboard\.press\(['"]Control\+S['"]\)/);
  assert.match(runner, /`--git-dir=\$\{path\.join\(cwd, '\.git'\)\}`/);
  assert.match(runner, /`--work-tree=\$\{cwd\}`/);
});
