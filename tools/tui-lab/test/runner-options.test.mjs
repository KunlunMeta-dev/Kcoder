import assert from 'node:assert/strict';
import test from 'node:test';

import {
  DEFAULT_MESSAGE,
  browserLaunchOptions,
  defaultCommandParts,
  defaultCommandString,
  expandCommandTemplate,
  parseArgs,
  ptyCommand,
  shellQuote,
} from '../lib/runner-options.mjs';

const defaults = { defaultWorkspaceTemplate: '/fixtures/workspace' };

test('software WebGL is explicit and disabled by default', () => {
  assert.equal(parseArgs([], defaults).softwareWebgl, false);
  assert.equal(parseArgs(['startup', '--software-webgl'], defaults).softwareWebgl, true);
  assert.deepEqual(browserLaunchOptions(parseArgs([], defaults)), { headless: true });
  assert.deepEqual(browserLaunchOptions(parseArgs(['startup', '--software-webgl'], defaults)), {
    headless: true,
    args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'],
  });
});

test('outline navigation inline mode is opt-in', () => {
  assert.equal(parseArgs(['outline-navigation'], defaults).outlineInline, false);
  assert.equal(parseArgs(['outline-navigation', '--outline-inline'], defaults).outlineInline, true);
  assert.equal(parseArgs(['outline-navigation', '--outline-streaming'], defaults).outlineStreaming, true);
});

test('parses stable defaults and command-specific defaults', () => {
  const run = parseArgs([], defaults);
  assert.equal(run.command, 'run');
  assert.equal(run.message, DEFAULT_MESSAGE);
  assert.equal(run.workspaceTemplate, '/fixtures/workspace');
  assert.equal(run.headless, true);

  const streaming = parseArgs(['streaming-scrollbar'], defaults);
  assert.equal(streaming.streamDelayMs, 80);
  const lsp = parseArgs(['lsp-diagnostics'], defaults);
  assert.equal(lsp.scenario, 'lsp-diagnostics');
  assert.match(lsp.message, /pyright/);
  const targetedStop = parseArgs(['targeted-subagent-stop'], defaults);
  assert.equal(targetedStop.scenario, 'subagent-trace');
  assert.match(targetedStop.message, /tui-lab-targeted-subagent-stop/);
});

test('parses explicit values and rejects missing or invalid values', () => {
  const options = parseArgs(
    ['open', '--scenario', 'mixed-tools', '--cols', '120', '--headed', '--steer-after-tool'],
    defaults,
  );
  assert.equal(options.command, 'open');
  assert.equal(options.scenario, 'mixed-tools');
  assert.equal(options.cols, 120);
  assert.equal(options.headless, false);
  assert.equal(options.steerAfterTool, true);
  assert.throws(() => parseArgs(['--rows'], defaults), /missing value/);
  assert.throws(() => parseArgs(['--rows', '4'], defaults), /--rows/);
  assert.throws(() => parseArgs(['--unknown'], defaults), /unknown option/);
});

test('builds argv without a shell unless an explicit command override requires one', () => {
  const direct = defaultCommandParts({ scenario: 'full-turn', workspaceDir: '/tmp/work' });
  assert.equal(direct.file, 'cargo');
  assert.deepEqual(direct.args.slice(-6), ['--', '--cwd', '/tmp/work', 'tui-dev', '--scenario', 'full-turn']);

  const orchestrate = defaultCommandParts({ scenario: 'orchestrate-control', workspaceDir: '/tmp/work' });
  assert.deepEqual(orchestrate.args.slice(-7), [
    '--',
    '--cwd',
    '/tmp/work',
    '--orchestrate',
    'tui-dev',
    '--scenario',
    'orchestrate-control',
  ]);

  const override = ptyCommand(
    { commandOverride: '{repoRoot}/bin/kcoder --cwd {workspace}', workspaceDir: 'C:\\Work Dir', runDir: 'C:\\Run' },
    { platform: 'win32', env: { KCODER_TUI_LAB_POWERSHELL: 'pwsh.exe' }, repoRoot: 'C:\\Repo Dir' },
  );
  assert.equal(override.file, 'pwsh.exe');
  assert.match(override.args.at(-1), /C:\\Repo Dir/);
});

test('expands and quotes commands through platform adapters', () => {
  const runtime = { platform: 'linux', repoRoot: '/repo root' };
  const options = { scenario: 'full-turn', workspaceDir: '/work tree', runDir: '/run dir' };
  assert.equal(shellQuote("O'Brien", runtime), "'O'\\''Brien'");
  assert.equal(expandCommandTemplate('tool {workspace} {runDir}', options, runtime), "tool '/work tree' '/run dir'");
  assert.match(defaultCommandString(options, runtime), /^'cargo' 'run'/);
});
