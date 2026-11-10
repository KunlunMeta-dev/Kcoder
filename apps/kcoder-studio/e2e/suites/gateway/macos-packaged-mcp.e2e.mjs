import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { isolatedEnvironment, requireExecutable, runE2E } from '../../harness/run-context.mjs';
import { waitForStdioChildClose } from '../../harness/app-server-stdio.mjs';

await runE2E(import.meta.url, {
  testId: 'macos-packaged-computer-use-mcp-discovery', tier: 'manual-live',
  modelPolicy: 'Packaged native CLI connects through its ordinary MCP implementation; no model or desktop input. Missing OS permissions stay explicit.',
}, async context => {
  assert.equal(process.platform, 'darwin', 'Native Mac required');
  assert.ok(process.env.KCODER_E2E_PACKAGED_DIR, 'Select the actual installed app');
  const resources = resolve(process.env.KCODER_E2E_PACKAGED_DIR, 'Contents/Resources');
  const binary = await requireExecutable(resolve(resources, 'bin/kcoder'), 'packaged CLI');
  const worker = await requireExecutable(resolve(resources, 'computer-use/peekaboo/peekaboo'), 'packaged Computer Use MCP');
  const pin = JSON.parse(await readFile(resolve(resources, 'computer-use/kcoder-macos-computer-use.json'), 'utf8'));
  assert.equal(pin.package, '@steipete/peekaboo');
  const home = context.pathInState('macos-mcp-home');
  const workspace = context.pathInState('macos-mcp-workspace');
  await mkdir(home, { mode: 0o700 });
  await mkdir(workspace, { mode: 0o700 });
  const settings = resolve(home, 'settings.json');
  await writeFile(settings, JSON.stringify({ providers: {}, tools: { profile: 'none' }, credential_store: 'file' }), { mode: 0o600 });
  const env = isolatedEnvironment({ HOME: home, USERPROFILE: home, KCODER_CONFIG_DIR: home });
  async function invoke(label, program, args) {
    const child = context.spawnOwned(label, program, args, { cwd: workspace, env, stdin: 'pipe' });
    let output = '';
    child.stdout.on('data', bytes => { output += bytes; assert.ok(Buffer.byteLength(output) < 128 * 1024); });
    const exit = await waitForStdioChildClose(child, 45000, label);
    await context.stopOwned(label);
    assert.equal(exit.code, 0, `${label} failed; inspect its owned log`);
    return output;
  }
  await invoke('configure-packaged-macos-mcp', binary, ['--settings-file', settings, 'mcp', 'add', 'macos-computer-use',
    '--command', worker, ...pin.args.map(arg => `--args=${arg}`)]);
  const catalog = await invoke('packaged-macos-mcp', binary, ['--settings-file', settings, 'mcp', 'test', 'macos-computer-use']);
  const count = /Initialized 'macos-computer-use': (\d+) tools/.exec(catalog);
  assert.ok(count && Number(count[1]) > 0, 'Ordinary KCoder MCP tool discovery must succeed');
  const permissions = JSON.parse(await invoke('packaged-macos-permissions', worker, ['permissions', 'status', '--json', '--no-remote']));
  assert.equal(permissions.success, true);
  const missingPermissions = permissions.data.permissions.filter(item => item.isRequired && !item.isGranted).map(item => item.name);
  const result = { packagedMcpConnected: true, toolCount: Number(count[1]), version: pin.version,
    missingPermissions, desktopInputTested: false, modelCalls: 0 };
  await context.writeArtifactJson('macos-computer-use-mcp.json', result);
  return result;
});
