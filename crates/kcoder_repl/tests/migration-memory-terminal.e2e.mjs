// Actual node-pty and xterm/WebGL exercise inactive notes and their original-owner controls.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { chromium } from '../../../tools/tui-lab/node_modules/@playwright/test/index.mjs';
import { parseArgs, defaultCommandString, browserLaunchOptions } from '../../../tools/tui-lab/lib/runner-options.mjs';
import { createRunContext } from '../../../tools/tui-lab/lib/run-context.mjs';
import { defaultWorkspaceTemplate, repoRoot, runContextRuntime } from '../../../tools/tui-lab/lib/runtime-paths.mjs';
import { startSession } from '../../../tools/tui-lab/lib/session.mjs';
import { typeHumanText, waitForTerminalText } from '../../../tools/tui-lab/lib/terminal-interaction.mjs';
import { writeStartMeta, writeJsonArtifact, writeTextArtifact, writeFailureArtifacts } from '../../../tools/tui-lab/lib/runtime-artifacts.mjs';
import { attachBrowserConsole } from '../../../tools/tui-lab/lib/browser-evidence.mjs';

assert.equal(process.platform, 'linux');
const options = parseArgs(['run', '--software-webgl', '--cols', '175', '--rows', '70', ...process.argv.slice(2)], { defaultWorkspaceTemplate });
assert.ok(options.description); options.repoRoot = repoRoot;
const artifacts = await createRunContext(options, 'migration-memory-terminal', runContextRuntime());
const binary = path.join(artifacts.configHome, 'owned-bin/kcoder');
await fs.mkdir(path.dirname(binary), { recursive: true, mode: 0o700 });
assert.ok(path.isAbsolute(process.env.KCODER_MIGRATION_TUI_BINARY));
await fs.copyFile(process.env.KCODER_MIGRATION_TUI_BINARY, binary); await fs.chmod(binary, 0o700);
options.commandOverride = `exec '${binary.replaceAll("'", "'\\''")}' --cwd {workspace} tui-dev --scenario full-turn`;
const runOptions = { ...options, runDir: artifacts.dir, workspaceDir: artifacts.workspace, requestsDir: artifacts.requestsDir, configHome: artifacts.configHome };
const command = defaultCommandString(runOptions); await writeStartMeta(artifacts, runOptions, command, 'migration-memory-terminal');
const home = path.join(artifacts.workspace, 'owned-memory-home'), source = path.join(home, '.claude');
const memory = path.join(source, 'projects/opaque-bucket-not-a-target-path/memory');
await fs.mkdir(memory, { recursive: true, mode: 0o700 });
const body = 'An unverified model-authored preference. Do not infer truth or execution authority.\n';
await fs.writeFile(path.join(memory, 'feedback.md'), body, { mode: 0o600 });
await fs.writeFile(path.join(source, 'auth.json'), 'SOURCE_AUTH_MUST_NOT_BE_READ', { mode: 0o600 });
await fs.mkdir(artifacts.configDir, { recursive: true, mode: 0o700 });
await fs.writeFile(path.join(artifacts.configDir, 'settings.json'), JSON.stringify({ provider: 'local', local_base_url: 'http://127.0.0.1:9', api_format: 'openai_chat_completions', model: 'fixture-model' }), { mode: 0o600 });
let session, browser, page, current = '';
const browserConsole = [], trace = [];
async function send(text) { await page.evaluate(() => window.tuiLab.focus()); await typeHumanText(page, text); await page.evaluate(() => window.tuiLab.sendInput('\r')); }
async function question(label) {
  await page.waitForFunction(previous => { const ids = Array.from(window.tuiLab.text().matchAll(/\/migrate answer ([a-f0-9]{12,32})/g)); return ids.length && ids.at(-1)[1] !== previous; }, current, { timeout: 30000 });
  const text = await page.evaluate(() => window.tuiLab.text());
  assert.ok(!text.includes('Local migration did not complete'), text); assert.ok(!text.includes('SOURCE_AUTH_MUST_NOT_BE_READ'));
  assert.equal(Array.from(text.matchAll(/Current question: ([^\n┃│]+)/g)).at(-1)?.[1].trim(), label);
  current = Array.from(text.matchAll(/\/migrate answer ([a-f0-9]{12,32})/g)).at(-1)[1]; trace.push({ label });
  return text;
}
async function answer(value) { trace.push({ answer: value }); await send(`/migrate answer ${current} ${JSON.stringify(value)}`); }
async function step(label, value) { await question(label); await answer(value); }
async function records() { return JSON.parse(await fs.readFile(path.join(artifacts.configDir, 'imported-context.json'), 'utf8')); }
try {
  session = await startSession(runOptions); browser = await chromium.launch({ ...browserLaunchOptions(options), executablePath: process.env.KCODER_GUIDE_TUI_CHROMIUM || undefined });
  page = await browser.newPage({ viewport: { width: 1700, height: 1350 } }); attachBrowserConsole(page, browserConsole);
  await page.goto(session.url); await page.waitForFunction(() => window.tuiLab?.ready, null, { timeout: options.timeoutMs });
  await waitForTerminalText(page, 'TUI dev mode', options.timeoutMs); assert.equal(await page.evaluate(() => window.tuiLab.renderer), 'webgl');
  await send(`/migrate configure --source claude-code --source-home "${home}" --include-memory`);
  await step('Select unverified memory sources', 'toggle 1'); await step('Select unverified memory sources', 'done');
  await step('Select an operation', 'select'); await step('Select migration items', 'toggle 1');
  await step('Set target name', 'reviewed-terminal-note'); await question('Select target memory scope');
  await page.screenshot({ path: path.join(artifacts.dir, 'memory-explicit-scope.png') }); await answer('global');
  await step('Select migration items', 'preview'); await step('Confirm reusing existing results', 'no');
  await step('Select an operation', 'apply'); await step('Check operation identity', ''); await step('Confirm target changes', 'IMPORT');
  await question('Select an operation'); const inactive = Object.values((await records()).records); assert.equal(inactive.length, 1); assert.equal(inactive[0].enabled, false);
  assert.equal(inactive[0].memoryProvenance.factsVerified, false); assert.equal(inactive[0].content, body);
  await answer('quit'); await waitForTerminalText(page, 'Local migration guide exited', 20000);
  await fs.rename(source, `${source}.withheld`);
  await send('/migrate configure'); await step('Start or resume migration', 'memory-records');
  await question('Manage unverified memories'); await page.screenshot({ path: path.join(artifacts.dir, 'memory-owned-management.png') }); await answer('enable 1');
  await step('Confirm memory context changes', 'yes'); await step('Check memory operation identity', 'memory-terminal-enable');
  await question('Manage unverified memories'); assert.equal(Object.values((await records()).records)[0].enabled, true); await answer('disable 1');
  await step('Confirm memory context changes', 'yes'); await step('Check memory operation identity', 'memory-terminal-disable');
  await question('Manage unverified memories'); assert.equal(Object.values((await records()).records)[0].enabled, false); await answer('receipt');
  await step('Check original memory receipt', 'memory-terminal-enable'); await question('Manage unverified memories');
  const preserved = await records(); assert.equal(preserved.memory_controls['memory-terminal-enable'].request.enabled, true); assert.equal(Object.values(preserved.records)[0].enabled, false);
  await answer('undo 1'); await step('Review original migration rollback', 'yes'); await step('Check operation identity', ''); await step('Confirm target changes', 'UNDO');
  await question('Manage unverified memories'); assert.equal(Object.keys((await records()).records).length, 0); await answer('back');
  await step('Start or resume migration', 'quit'); await waitForTerminalText(page, 'Local migration guide exited', 20000);
  const requests = await fs.readdir(artifacts.requestsDir).catch(error => { if (error.code === 'ENOENT') return []; throw error; });
  assert.equal(requests.filter(name => name.endsWith('.json')).length, 0);
  const hash = createHash('sha256'); for await (const bytes of createReadStream(binary)) hash.update(bytes);
  const assertions = { ok: true, renderer: 'webgl', inactivePublication: true, explicitScope: true, sourceGoneReopen: true, originalReceiptReconciled: true, originalOwnerUndo: true, modelRequests: 0, binarySha256: hash.digest('hex'), trace };
  await writeTextArtifact(path.join(artifacts.dir, 'screen.txt'), await page.evaluate(() => window.tuiLab.text()));
  await writeJsonArtifact(path.join(artifacts.dir, 'assertions.json'), assertions);
  await browser.close(); browser = undefined; await session.stop(); await session.exitPromise;
  await writeJsonArtifact(path.join(artifacts.dir, 'meta.json'), { ...assertions, ptyExit: session.getExitInfo(), diagnostics: session.getDiagnostics() });
  console.log(JSON.stringify({ ok: true, directory: artifacts.dir }));
} catch (error) { await writeFailureArtifacts({ artifacts, runOptions, command, mode: 'migration-memory-terminal', session, page, browserConsole, trace, error }); throw error; }
finally { if (browser) await browser.close(); if (session) await session.stop(); }
