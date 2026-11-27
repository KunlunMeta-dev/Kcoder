// Real execution through generated POSIX launchers against the staged,
// lockfile-installed skill tree. Requires
// `pnpm --dir apps/kcoder-studio/skill-runtime install --frozen-lockfile --ignore-scripts`.
// The lark-cli case additionally needs a directory prepared by
// `node scripts/release/prepare-lark-cli.mjs --platform <host> --dest <dir>/lark-cli`
// and named by KCODER_STUDIO_TEST_LARK_CLI_DIR.
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { access, cp, mkdir, mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { stageSkillRuntimeDependencies } from '../desktop/stage-skill-runtime-dependencies.mjs';
import { composeSkillNodeEnvironment, prepareSkillNodeRuntime } from './skill-node-runtime.mjs';

const run = promisify(execFile);
const sourceRoot = fileURLToPath(new URL('../skill-runtime', import.meta.url));
let installed = true;
try { await access(join(sourceRoot, 'node_modules', '.pnpm', 'lock.yaml')); } catch { installed = false; }
const skip = process.platform === 'win32' ? 'POSIX launcher execution'
  : installed ? false : 'skill runtime packages are not installed (pnpm --dir apps/kcoder-studio/skill-runtime install --frozen-lockfile --ignore-scripts)';

test('generated launchers run docx, pptxgenjs and the bundled Playwright MCP CLI on the current executable', { skip, timeout: 120_000 }, async t => {
  const root = await mkdtemp(join(tmpdir(), 'kcoder skill 运行时 '));
  t.after(() => rm(root, { recursive: true, force: true }));
  const staged = await stageSkillRuntimeDependencies({ sourceRoot, destination: join(root, 'resources', 'skill-runtime', 'node_modules') });
  assert.deepEqual(Object.keys(staged.packages).sort(), ['@playwright/mcp', 'docx', 'pptxgenjs']);
  const warnings = [];
  const runtime = await prepareSkillNodeRuntime({ env: {}, gatewayRoot: join(root, 'resources', 'gateway'),
    dataDirectory: join(root, 'data'), executable: process.execPath, warn: message => warnings.push(message) });
  assert.deepEqual(warnings, []);
  assert.equal(await realpath(runtime.nodeModules), staged.output);
  assert.deepEqual([...runtime.launchers].sort(), ['node', 'playwright-mcp']);
  // No inherited NODE_PATH, npm or project packages: only the composed environment.
  const env = composeSkillNodeEnvironment({ PATH: '/usr/bin:/bin', HOME: root }, runtime);
  const options = { cwd: root, env, timeout: 60_000 };

  const node = await run(join(runtime.binDirectory, 'node'),
    ['-e', "console.log(require('docx').Document !== undefined, typeof require('pptxgenjs'), process.env.ELECTRON_RUN_AS_NODE)"], options);
  assert.equal(node.stdout.trim(), 'true function 1');
  await assert.rejects(run(join(runtime.binDirectory, 'node'), ['-e', 'process.exit(7)'], options), error => error.code === 7);

  const playwright = await run(join(runtime.binDirectory, 'playwright-mcp'), ['--help'], options);
  assert.match(playwright.stdout, /--browser <browser>/);
});

const preparedLarkCli = process.env.KCODER_STUDIO_TEST_LARK_CLI_DIR;
const larkSkip = process.platform === 'win32' ? 'POSIX PATH execution'
  : preparedLarkCli ? false : 'set KCODER_STUDIO_TEST_LARK_CLI_DIR to a directory prepared by scripts/release/prepare-lark-cli.mjs';

test('the packaged lark-cli resolves by name through the composed PATH only', { skip: larkSkip, timeout: 60_000 }, async t => {
  const root = await mkdtemp(join(tmpdir(), 'kcoder lark 运行时 '));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, 'resources', 'gateway'), { recursive: true });
  await cp(preparedLarkCli, join(root, 'resources', 'lark-cli'), { recursive: true });
  const warnings = [];
  const runtime = await prepareSkillNodeRuntime({ env: {}, gatewayRoot: join(root, 'resources', 'gateway'),
    dataDirectory: join(root, 'data'), executable: process.execPath, warn: message => warnings.push(message) });
  assert.equal(runtime.larkCliDirectory, join(root, 'resources', 'lark-cli'));
  // HOME points at the scratch root: no user configuration, login or keychain entry is read.
  const base = { PATH: '/usr/bin:/bin', HOME: root, LARKSUITE_CLI_NO_UPDATE_NOTIFIER: '1', LARKSUITE_CLI_NO_SKILLS_NOTIFIER: '1' };
  await assert.rejects(run('lark-cli', ['--version'], { cwd: root, env: base, timeout: 30_000 }), error => error.code === 'ENOENT',
    'lark-cli is not resolvable without the composed environment');
  const env = composeSkillNodeEnvironment(base, runtime);
  const options = { cwd: root, env, timeout: 30_000 };
  const version = await run('lark-cli', ['--version'], options);
  assert.match(version.stdout, /1\.0\.100/);
  const help = await run('lark-cli', ['--help'], options);
  assert.match(help.stdout, /auth/);
  assert.match(help.stdout, /config/);
});
