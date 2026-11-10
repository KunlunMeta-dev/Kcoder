// Actual node-pty and xterm/WebGL exercise explicit instruction scope and original capture recovery.
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

assert.equal(process.platform, 'linux', 'This acceptance records Linux only.');
const options = parseArgs(['run', '--software-webgl', '--cols', '180', '--rows', '75', ...process.argv.slice(2)], { defaultWorkspaceTemplate });
assert.ok(options.description); options.repoRoot = repoRoot;
const artifacts = await createRunContext(options, 'migration-instructions-terminal', runContextRuntime());
assert.ok(path.isAbsolute(process.env.KCODER_MIGRATION_TUI_BINARY));
const binary = path.join(artifacts.configHome, 'owned-bin/kcoder');
await fs.mkdir(path.dirname(binary), { recursive: true, mode: 0o700 });
await fs.copyFile(process.env.KCODER_MIGRATION_TUI_BINARY, binary); await fs.chmod(binary, 0o700);
options.commandOverride = `exec '${binary.replaceAll("'", "'\\''")}' --cwd {workspace} tui-dev --scenario full-turn`;
const runOptions = { ...options, runDir: artifacts.dir, workspaceDir: artifacts.workspace, requestsDir: artifacts.requestsDir, configHome: artifacts.configHome };
const command = defaultCommandString(runOptions); await writeStartMeta(artifacts, runOptions, command, 'migration-instructions-terminal');
const source = path.join(artifacts.workspace, 'owned-instruction-source');
await fs.mkdir(path.join(source, '.git'), { recursive: true, mode: 0o700 });
const originalBody = '<!-- ORIGINAL_COMMENT_FOR_EXPLICIT_RAW_PREVIEW -->\nUse @rules.md\n';
const compiledRule = 'EXPLICIT_SCOPED_INSTRUCTION_BODY Keep normal project examples.\n';
await fs.writeFile(path.join(source, 'CLAUDE.md'), originalBody, { mode: 0o600 });
await fs.writeFile(path.join(source, 'rules.md'), compiledRule, { mode: 0o600 });
await fs.mkdir(artifacts.configDir, { recursive: true, mode: 0o700 });
const settings = JSON.stringify({ provider: 'local', local_base_url: 'http://127.0.0.1:9', api_format: 'openai_chat_completions', model: 'fixture-model' });
await fs.writeFile(path.join(artifacts.configDir, 'settings.json'), settings, { mode: 0o600 });
await fs.writeFile(path.join(artifacts.configDir, 'trusted-folders.json'), JSON.stringify({ trusted: [source, artifacts.workspace], never: [] }), { mode: 0o600 });
let session, browser, page, current = '', jobId, requestId;
const browserConsole = [], trace = [];
async function send(text) { await page.evaluate(() => window.tuiLab.focus()); await typeHumanText(page, text); await page.evaluate(() => window.tuiLab.sendInput('\r')); }
async function question(label) {
  await page.waitForFunction(previous => { const ids = Array.from(window.tuiLab.text().matchAll(/\/migrate answer ([a-f0-9]{12,32})/g)); return ids.length && ids.at(-1)[1] !== previous; }, current, { timeout: 30000 });
  const text = await page.evaluate(() => window.tuiLab.text());
  assert.ok(!text.includes('本地迁移未完成'), text);
  assert.equal(Array.from(text.matchAll(/当前问题：([^\n┃│]+)/g)).at(-1)?.[1].trim(), label);
  current = Array.from(text.matchAll(/\/migrate answer ([a-f0-9]{12,32})/g)).at(-1)[1]; trace.push({ label });
  return text;
}
async function answer(value) { await send(`/migrate answer ${current} ${JSON.stringify(value)}`); }
async function step(label, value) { await question(label); await answer(value); }
async function contexts() { return Object.values(JSON.parse(await fs.readFile(path.join(artifacts.configDir, 'imported-context.json'), 'utf8')).records); }
try {
  session = await startSession(runOptions); browser = await chromium.launch({ ...browserLaunchOptions(options), executablePath: process.env.KCODER_GUIDE_TUI_CHROMIUM || undefined });
  page = await browser.newPage({ viewport: { width: 1750, height: 1420 } }); attachBrowserConsole(page, browserConsole);
  await page.goto(session.url); await page.waitForFunction(() => window.tuiLab?.ready, null, { timeout: options.timeoutMs });
  await waitForTerminalText(page, 'TUI dev mode', options.timeoutMs); assert.equal(await page.evaluate(() => window.tuiLab.renderer), 'webgl');
  await send('/migrate');
  await step('开始或恢复迁移', 'instructions'); await step('核对指令捕获请求', '');
  await step('选择指令来源格式', 'claude-code'); await step('授权指令来源根', source);
  await step('选择来源启动目录', ''); await step('确认只读指令来源', 'yes'); await step('选择子目录指令范围', 'no');
  await step('确认静态指令解释子集', 'yes');
  await question('选择指令与目标映射');
  assert.ok(!(await page.evaluate(() => window.tuiLab.text())).includes('EXPLICIT_SCOPED_INSTRUCTION_BODY'));
  await answer('details 1'); await question('选择指令与目标映射');
  assert.ok((await page.evaluate(() => window.tuiLab.text())).includes('scoped-instructions/v2'));
  await answer('preview 1'); await question('选择指令与目标映射');
  assert.ok(textContainsAcrossWrap(await page.evaluate(() => window.tuiLab.text()), 'EXPLICIT_SCOPED_INSTRUCTION_BODY'));
  assert.ok(!(await page.evaluate(() => window.tuiLab.text())).includes('ORIGINAL_COMMENT_FOR_EXPLICIT_RAW_PREVIEW'));
  await answer('toggle 1'); await step('映射目标指令目录', '.'); await step('选择指令与目标映射', 'done');
  const captureText = await question('确认封存指令快照');
  requestId = Array.from(captureText.matchAll(/"requestId":\s*"([a-f0-9-]{36})"/g)).at(-1)?.[1]; assert.ok(requestId);
  await page.screenshot({ path: path.join(artifacts.dir, 'instruction-explicit-mapping.png') }); await answer('CAPTURE');
  await step('选择操作', 'select'); await step('选择迁移项目', 'toggle 1'); await step('设置目标名称', 'terminal-scoped-guide');
  await step('确认资产启用', 'no'); await step('选择迁移项目', 'preview'); await step('确认已有结果复用', 'no');
  await step('选择操作', 'apply'); await step('核对操作身份', ''); await step('确认目标变更', 'IMPORT');
  await question('选择操作'); const records = await contexts(); assert.equal(records.length, 1); assert.equal(records[0].enabled, false);
  assert.equal(records[0].scope.kind, 'project'); assert.equal(records[0].scope.root, artifacts.workspace);
  assert.equal(records[0].instructionProvenance.trigger, 'launch');
  assert.ok(records[0].content.includes(compiledRule));
  assert.ok(!records[0].content.includes('ORIGINAL_COMMENT_FOR_EXPLICIT_RAW_PREVIEW'));
  assert.equal(records[0].instructionProvenance.sourceFileIdentity, undefined);
  assert.equal(records[0].instructionProvenance.sourceSha256, createHash('sha256').update(originalBody).digest('hex'));
  const names = await fs.readdir(path.join(artifacts.configDir, 'migrations'));
  for (const name of names.filter(name => /^mig-[a-f0-9]{32}\.json$/.test(name))) {
    const job = JSON.parse(await fs.readFile(path.join(artifacts.configDir, 'migrations', name), 'utf8'));
    if (job.batch?.creation?.requestId === requestId) { assert.equal(job.status, 'completed'); jobId = job.jobId; }
  }
  assert.ok(jobId); await answer('quit'); await waitForTerminalText(page, '本地迁移向导已退出', 20000);
  await fs.rename(source, `${source}.withheld`);
  await send('/migrate'); await step('开始或恢复迁移', 'creation'); await step('打开原捕获请求', requestId);
  await question('选择操作'); await answer('instructions'); await step('查看封存指令原文', 'compiled 1');
  await question('查看封存指令原文');
  let visible = textContainsAcrossWrap(await page.evaluate(() => window.tuiLab.text()), 'EXPLICIT_SCOPED_INSTRUCTION_BODY');
  for (let moved = 0; moved < 6 && !visible; moved++) {
    await pressRepeated(page, 'PageUp', 1);
    visible = textContainsAcrossWrap(await page.evaluate(() => window.tuiLab.text()), 'EXPLICIT_SCOPED_INSTRUCTION_BODY');
  }
  assert.ok(visible, 'Explicit saved body is available after the original source is gone.');
  await page.screenshot({ path: path.join(artifacts.dir, 'instruction-source-gone-compiled.png') }); await pressRepeated(page, 'PageDown', 6);
  await answer('1'); await question('查看封存指令原文');
  assert.ok(textContainsAcrossWrap(await page.evaluate(() => window.tuiLab.text()), 'ORIGINAL_COMMENT_FOR_EXPLICIT_RAW_PREVIEW'));
  await page.screenshot({ path: path.join(artifacts.dir, 'instruction-source-gone-original.png') });
  await answer('back'); await step('选择操作', 'undo'); await step('核对操作身份', ''); await step('确认目标变更', 'UNDO');
  await question('选择操作'); assert.equal((await contexts()).length, 0); await answer('quit'); await waitForTerminalText(page, '本地迁移向导已退出', 20000);
  assert.equal(await fs.readFile(path.join(artifacts.configDir, 'settings.json'), 'utf8'), settings);
  await assert.rejects(fs.stat(path.join(artifacts.configDir, 'skills/terminal-scoped-guide')), { code: 'ENOENT' });
  const requests = await fs.readdir(artifacts.requestsDir).catch(error => { if (error.code === 'ENOENT') return []; throw error; });
  assert.equal(requests.filter(name => name.endsWith('.json')).length, 0);
  const hash = createHash('sha256'); for await (const bytes of createReadStream(binary)) hash.update(bytes);
  const assertions = { ok: true, renderer: 'webgl', sourceFormat: 'scoped-instructions/v2', rawAndCompiledDistinct: true, rawReadFactNotReused: true, originalRequestRecovery: true, explicitSourceAndTarget: true, defaultInactive: true, sourceGonePreview: true, originalOwnerUndo: true, modelRequests: 0, jobId, requestId, binarySha256: hash.digest('hex'), trace };
  await writeTextArtifact(path.join(artifacts.dir, 'screen.txt'), await page.evaluate(() => window.tuiLab.text()));
  await writeJsonArtifact(path.join(artifacts.dir, 'assertions.json'), assertions);
  await browser.close(); browser = undefined; await session.stop(); await session.exitPromise;
  await writeJsonArtifact(path.join(artifacts.dir, 'meta.json'), { ...assertions, ptyExit: session.getExitInfo(), diagnostics: session.getDiagnostics() });
  console.log(JSON.stringify({ ok: true, directory: artifacts.dir }));
} catch (error) { await writeFailureArtifacts({ artifacts, runOptions, command, mode: 'migration-instructions-terminal', session, page, browserConsole, trace, error }); throw error; }
finally { if (browser) await browser.close(); if (session) await session.stop(); }
