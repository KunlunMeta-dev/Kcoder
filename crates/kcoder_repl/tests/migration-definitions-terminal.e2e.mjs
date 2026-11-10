// Actual node-pty and xterm/WebGL exercise passive definitions without runtime activation.
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
import { pressRepeated, textContainsAcrossWrap } from '../../../tools/tui-lab/lib/scroll-metrics.mjs';
import { writeStartMeta, writeJsonArtifact, writeTextArtifact, writeFailureArtifacts } from '../../../tools/tui-lab/lib/runtime-artifacts.mjs';
import { attachBrowserConsole } from '../../../tools/tui-lab/lib/browser-evidence.mjs';

assert.equal(process.platform, 'linux');
const options = parseArgs(['run', '--software-webgl', '--cols', '175', '--rows', '70', ...process.argv.slice(2)], { defaultWorkspaceTemplate });
assert.ok(options.description); options.repoRoot = repoRoot;
const artifacts = await createRunContext(options, 'migration-definitions-terminal', runContextRuntime());
const binary = path.join(artifacts.configHome, 'owned-bin/kcoder');
await fs.mkdir(path.dirname(binary), { recursive: true, mode: 0o700 });
assert.ok(path.isAbsolute(process.env.KCODER_MIGRATION_TUI_BINARY));
await fs.copyFile(process.env.KCODER_MIGRATION_TUI_BINARY, binary); await fs.chmod(binary, 0o700);
options.commandOverride = `exec '${binary.replaceAll("'", "'\\''")}' --cwd {workspace} tui-dev --scenario full-turn`;
const runOptions = { ...options, runDir: artifacts.dir, workspaceDir: artifacts.workspace, requestsDir: artifacts.requestsDir, configHome: artifacts.configHome };
const command = defaultCommandString(runOptions); await writeStartMeta(artifacts, runOptions, command, 'migration-definitions-terminal');
const home = path.join(artifacts.workspace, 'owned-definition-home'), source = path.join(home, '.claude');
const agents = path.join(source, 'agents');
await fs.mkdir(agents, { recursive: true, mode: 0o700 });
const body = '---\nname: fixture\ndescription: passive source definition\ntools: Bash\npermissionMode: bypassPermissions\n---\nEXPLICIT_DEFINITION_BODY Never execute source definitions.\n';
await fs.writeFile(path.join(agents, 'fixture.md'), body, { mode: 0o600 });
await fs.writeFile(path.join(source, 'auth.json'), 'SOURCE_AUTH_MUST_NOT_BE_READ', { mode: 0o600 });
await fs.mkdir(artifacts.configDir, { recursive: true, mode: 0o700 });
await fs.writeFile(path.join(artifacts.configDir, 'settings.json'), JSON.stringify({ provider: 'local', local_base_url: 'http://127.0.0.1:9', api_format: 'openai_chat_completions', model: 'fixture-model' }), { mode: 0o600 });
let session, browser, page, current = '';
const browserConsole = [], trace = [];
async function send(text) { await page.evaluate(() => window.tuiLab.focus()); await typeHumanText(page, text); await page.evaluate(() => window.tuiLab.sendInput('\r')); }
async function question(label) {
  await page.waitForFunction(previous => { const ids = Array.from(window.tuiLab.text().matchAll(/\/migrate answer ([a-f0-9]{12,32})/g)); return ids.length && ids.at(-1)[1] !== previous; }, current, { timeout: 30000 });
  const text = await page.evaluate(() => window.tuiLab.text());
  assert.ok(!text.includes('本地迁移未完成'), text); assert.ok(!text.includes('SOURCE_AUTH_MUST_NOT_BE_READ'));
  assert.equal(Array.from(text.matchAll(/当前问题：([^\n┃│]+)/g)).at(-1)?.[1].trim(), label);
  current = Array.from(text.matchAll(/\/migrate answer ([a-f0-9]{12,32})/g)).at(-1)[1]; trace.push({ label });
  return text;
}
async function answer(value) { trace.push({ answer: value }); await send(`/migrate answer ${current} ${JSON.stringify(value)}`); }
async function step(label, value) { await question(label); await answer(value); }
async function records() { return JSON.parse(await fs.readFile(path.join(artifacts.configDir, 'migrations/pending-definitions/migration-pending-definitions.json'), 'utf8')); }
try {
  session = await startSession(runOptions); browser = await chromium.launch({ ...browserLaunchOptions(options), executablePath: process.env.KCODER_GUIDE_TUI_CHROMIUM || undefined });
  page = await browser.newPage({ viewport: { width: 1700, height: 1350 } }); attachBrowserConsole(page, browserConsole);
  await page.goto(session.url); await page.waitForFunction(() => window.tuiLab?.ready, null, { timeout: options.timeoutMs });
  await waitForTerminalText(page, 'TUI dev mode', options.timeoutMs); assert.equal(await page.evaluate(() => window.tuiLab.renderer), 'webgl');
  await send(`/migrate configure --source claude-code --source-home "${home}" --include-definitions`);
  await step('选择设置写入范围', 'user');
  await step('选择待处理Agent/Hook来源', 'toggle 1'); await step('选择待处理Agent/Hook来源', 'done');
  await step('选择操作', 'select'); await step('选择迁移项目', 'toggle 1');
  await step('设置目标名称', 'pending-terminal-agent'); await question('确认只保存待处理定义');
  await page.screenshot({ path: path.join(artifacts.dir, 'definition-explicit-pending.png') }); await answer('yes');
  await step('选择迁移项目', 'preview'); await step('确认已有结果复用', 'no');
  await step('选择操作', 'apply'); await step('核对操作身份', ''); await step('确认目标变更', 'IMPORT');
  await question('选择操作'); const inactive = Object.values((await records()).records); assert.equal(inactive.length, 1);
  assert.equal(inactive[0].report.executionAllowed, false); assert.equal(inactive[0].report.requiresReview, true);
  assert.equal(Buffer.from(inactive[0].data, 'base64').toString(), body);
  await assert.rejects(fs.stat(path.join(artifacts.configDir, 'skills/pending-terminal-agent')), { code: 'ENOENT' });
  const migrations = await fs.readdir(path.join(artifacts.configDir, 'migrations'));
  let jobId;
  for (const name of migrations.filter(name => /^mig-[a-f0-9]{32}\.json$/.test(name))) {
    const job = JSON.parse(await fs.readFile(path.join(artifacts.configDir, 'migrations', name), 'utf8'));
    if (job.inventory.items.some(item => item.preview.category === 'agent')) jobId = job.jobId;
  }
  assert.ok(jobId); await answer('quit'); await waitForTerminalText(page, '本地迁移向导已退出', 20000);
  await fs.rename(source, `${source}.withheld`);
  await send(`/migrate configure --job-id ${jobId}`); await step('选择操作', 'definitions');
  await step('选择待处理定义', '1'); await question('查看定义字段报告');
  assert.ok(!textContainsAcrossWrap(await page.evaluate(() => window.tuiLab.text()), 'EXPLICIT_DEFINITION_BODY'));
  await answer('body'); await question('查看定义字段报告');
  let bodyVisible = textContainsAcrossWrap(await page.evaluate(() => window.tuiLab.text()), 'EXPLICIT_DEFINITION_BODY');
  for (let moved = 0; moved < 6 && !bodyVisible; moved++) {
    const previousViewport = await page.evaluate(() => window.tuiLab.text());
    await pressRepeated(page, 'PageUp', 1);
    await page.waitForFunction(previous => window.tuiLab.text() !== previous, previousViewport, { timeout: 1500 }).catch(() => {});
    await writeTextArtifact(path.join(artifacts.dir, `definition-body-viewport-${moved + 1}.txt`), await page.evaluate(() => window.tuiLab.text()));
    bodyVisible = textContainsAcrossWrap(await page.evaluate(() => window.tuiLab.text()), 'EXPLICIT_DEFINITION_BODY');
  }
  assert.ok(bodyVisible, 'explicit body remains available in the actual managed TUI transcript');
  await page.screenshot({ path: path.join(artifacts.dir, 'definition-source-gone-preview.png') });
  await pressRepeated(page, 'PageDown', 6);
  await answer('back'); await step('选择待处理定义', 'back'); await step('选择操作', 'undo');
  await step('核对操作身份', ''); await step('确认目标变更', 'UNDO');
  await question('选择操作'); assert.equal(Object.keys((await records()).records).length, 0); await answer('quit');
  await waitForTerminalText(page, '本地迁移向导已退出', 20000);
  const requests = await fs.readdir(artifacts.requestsDir).catch(error => { if (error.code === 'ENOENT') return []; throw error; });
  assert.equal(requests.filter(name => name.endsWith('.json')).length, 0);
  const hash = createHash('sha256'); for await (const bytes of createReadStream(binary)) hash.update(bytes);
  const assertions = { ok: true, renderer: 'webgl', passivePublication: true, noRuntimeStore: true, explicitBodyOnly: true, sourceGoneReopen: true, originalOwnerUndo: true, modelRequests: 0, binarySha256: hash.digest('hex'), trace };
  await writeTextArtifact(path.join(artifacts.dir, 'screen.txt'), await page.evaluate(() => window.tuiLab.text()));
  await writeJsonArtifact(path.join(artifacts.dir, 'assertions.json'), assertions);
  await browser.close(); browser = undefined; await session.stop(); await session.exitPromise;
  await writeJsonArtifact(path.join(artifacts.dir, 'meta.json'), { ...assertions, ptyExit: session.getExitInfo(), diagnostics: session.getDiagnostics() });
  console.log(JSON.stringify({ ok: true, directory: artifacts.dir }));
} catch (error) { await writeFailureArtifacts({ artifacts, runOptions, command, mode: 'migration-definitions-terminal', session, page, browserConsole, trace, error }); throw error; }
finally { if (browser) await browser.close(); if (session) await session.stop(); }
