// Real PTY/xterm WebGL consumes the existing owned Gateway and Native recovery record.
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
const gateway = process.env.KCODER_GUIDE_TUI_GATEWAY, record = process.env.KCODER_GUIDE_TUI_RECORD;
assert.equal(new URL(gateway).hostname, '127.0.0.1', 'the calling E2E run owns this Gateway');
assert.ok(path.isAbsolute(record) && process.env.KCODER_OWNED_GUIDE_TUI_ACCESS);
const original = JSON.parse(await fs.readFile(record, 'utf8'));
const options = parseArgs(['run', '--software-webgl', '--cols', '175', '--rows', '70', ...process.argv.slice(2)], { defaultWorkspaceTemplate });
assert.ok(options.description); options.repoRoot = repoRoot;
const artifacts = await createRunContext(options, 'migration-guided-transfer-terminal', runContextRuntime());
const binary = path.join(artifacts.configHome, 'owned-bin/kcoder');
await fs.mkdir(path.dirname(binary), { recursive: true, mode: 0o700 });
await fs.copyFile(process.env.KCODER_MIGRATION_TUI_BINARY, binary); await fs.chmod(binary, 0o700);
options.commandOverride = `exec '${binary.replaceAll("'", "'\\''")}' --cwd {workspace} tui-dev --scenario full-turn`;
const runOptions = { ...options, runDir: artifacts.dir, workspaceDir: artifacts.workspace, requestsDir: artifacts.requestsDir, configHome: artifacts.configHome };
const command = defaultCommandString(runOptions); await writeStartMeta(artifacts, runOptions, command, 'migration-guided-transfer-terminal');
await fs.mkdir(artifacts.configDir, { recursive: true, mode: 0o700 });
await fs.writeFile(path.join(artifacts.configDir, 'settings.json'), JSON.stringify({ provider: 'local', local_base_url: 'http://127.0.0.1:9', api_format: 'openai_chat_completions', model: 'fixture-model' }), { mode: 0o600 });
let session, browser, page, current = '';
const browserConsole = [], trace = [];
async function send(text) { await page.evaluate(() => window.tuiLab.focus()); await typeHumanText(page, text); await page.evaluate(() => window.tuiLab.sendInput('\r')); }
async function question(label) {
  await page.waitForFunction(previous => {
    const ids = Array.from(window.tuiLab.text().matchAll(/\/migrate answer ([a-f0-9]{12,32})/g));
    return ids.length && ids.at(-1)[1] !== previous;
  }, current, { timeout: 30000 });
  const text = await page.evaluate(() => window.tuiLab.text());
  assert.ok(!text.includes('本地迁移未完成'), text);
  assert.ok(!text.includes(process.env.KCODER_OWNED_GUIDE_TUI_ACCESS));
  const labels = Array.from(text.matchAll(/当前问题：([^\n┃│]+)/g)); assert.equal(labels.at(-1)?.[1].trim(), label);
  current = Array.from(text.matchAll(/\/migrate answer ([a-f0-9]{12,32})/g)).at(-1)[1]; trace.push({ label });
}
async function answer(value) { await send(`/migrate answer ${current} ${JSON.stringify(value)}`); }
async function binaryHash() { const hash = createHash('sha256'); for await (const bytes of createReadStream(binary)) hash.update(bytes); return hash.digest('hex'); }
try {
  session = await startSession(runOptions); browser = await chromium.launch({ ...browserLaunchOptions(options),
    executablePath: process.env.KCODER_GUIDE_TUI_CHROMIUM || undefined });
  page = await browser.newPage({ viewport: { width: 1700, height: 1350 } }); attachBrowserConsole(page, browserConsole);
  await page.goto(session.url); await page.waitForFunction(() => window.tuiLab?.ready, null, { timeout: options.timeoutMs });
  await waitForTerminalText(page, 'TUI dev mode', options.timeoutMs); assert.equal(await page.evaluate(() => window.tuiLab.renderer), 'webgl');
  await send(`/migrate transfer --gateway "${gateway}" --access-token-env KCODER_OWNED_GUIDE_TUI_ACCESS guide --record "${record}"`);
  if (process.env.KCODER_GUIDE_TUI_PRIVATE === '1') {
    await question('处理跨目标迁移'); await answer('read');
    await question('处理跨目标迁移'); await answer('adoption-read');
    await question('处理跨目标迁移'); await answer('batch');
    await question('选择接纳批次'); await answer('1');
    await question('处理远端批次'); await answer('private');
    await question('处理原私密传输记录'); await answer('status');
    await question('处理原私密传输记录'); await answer('select 1');
    await question('处理原私密传输记录'); await answer('read');
    await question('处理原私密传输记录'); await answer('select 2');
    await question('处理原私密传输记录'); await answer('read');
    await question('处理原私密传输记录');
    await page.screenshot({ path: path.join(artifacts.dir, 'native-recovered-private-intent.png') });
    await answer('back');
    await question('处理远端批次'); await answer('back');
    await question('处理跨目标迁移'); await answer('release');
    await question('确认释放迁移连接'); await answer('yes');
    await question('处理跨目标迁移'); await answer('quit');
    await waitForTerminalText(page, '本地迁移向导已退出', 20000);
  } else if (process.env.KCODER_GUIDE_TUI_PROJECTS === '1') {
    await question('处理跨目标迁移'); await answer('read');
    await question('处理跨目标迁移'); await answer('adoption-read');
    await question('处理跨目标迁移'); await answer('batch');
    await question('选择接纳批次'); await answer('1');
    await question('处理远端批次'); await answer('projects');
    await question('查看原项目记录'); await answer('1');
    await question('查看项目原出处与保存映射');
    await page.screenshot({ path: path.join(artifacts.dir, 'sourcegone-project-report.png') });
    await answer('back');
    await question('查看原项目记录'); await answer('back');
    await question('处理远端批次'); await answer('back');
    await question('处理跨目标迁移'); await answer('release');
    await question('确认释放迁移连接'); await answer('yes');
    await question('处理跨目标迁移'); await answer('quit');
    await waitForTerminalText(page, '本地迁移向导已退出', 20000);
  } else if (process.env.KCODER_GUIDE_TUI_INSTRUCTIONS === '1') {
    await question('处理跨目标迁移'); await answer('read');
    await question('处理跨目标迁移'); await answer('adoption-read');
    await question('处理跨目标迁移'); await answer('batch');
    await question('选择接纳批次'); await answer('1');
    await question('处理远端批次'); await answer('instructions');
    await question('预览原批次指令快照'); await answer('original 1');
    await question('预览原批次指令快照'); await answer('compiled 1');
    await question('预览原批次指令快照');
    await page.screenshot({ path: path.join(artifacts.dir, 'native-reopened-instruction-compiled.png') });
    await answer('back');
    await question('处理远端批次'); await answer('back');
    await question('处理跨目标迁移'); await answer('release');
    await question('确认释放迁移连接'); await answer('yes');
    await question('处理跨目标迁移'); await answer('quit');
    await waitForTerminalText(page, '本地迁移向导已退出', 20000);
  } else if (process.env.KCODER_GUIDE_TUI_SOURCE_VIEWS === '1') {
    const root = process.env.KCODER_GUIDE_TUI_SOURCE_ROOT;
    assert.ok(path.isAbsolute(root));
    await question('处理跨目标迁移'); await answer('select');
    await question('选择传输资料'); await answer('report 1');
    await question('查看设置层次'); await answer('next');
    await question('查看设置层次'); await page.screenshot({ path: path.join(artifacts.dir, 'native-source-layers-page-two.png') }); await answer('back');
    await question('选择传输资料'); await answer('done');
    await question('处理跨目标迁移'); await answer('source-reset');
    await question('确认重新选择来源'); await answer('yes');
    await question('处理跨目标迁移'); await answer('select');
    await question('选择来源主机目录'); await answer('directory');
    await question('输入来源主机产品根'); await answer(root);
    await question('授权所选来源目录'); await answer('yes');
    await question('选择传输资料'); await answer('layers 1');
    await question('查看设置层次'); await answer('back');
    await question('选择传输资料'); await answer('done');
    await question('处理跨目标迁移'); await answer('quit');
    await waitForTerminalText(page, '本地迁移向导已退出', 20000);
  } else {
  await question('处理跨目标迁移'); await answer('read');
  await question('处理跨目标迁移'); await answer('adoption-read');
  await question('处理跨目标迁移'); await page.screenshot({ path: path.join(artifacts.dir, 'native-reopened-receipt.png') }); await answer('batch');
  await question('选择接纳批次'); await answer('1');
  await question('处理远端批次'); await page.screenshot({ path: path.join(artifacts.dir, 'native-remote-batch-reader.png') }); await answer('back');
  await question('处理跨目标迁移'); await answer('release');
  await question('确认释放迁移连接'); await answer('yes');
  await question('处理跨目标迁移'); await answer('quit');
  await waitForTerminalText(page, '本地迁移向导已退出', 20000);
  }
  const restored = JSON.parse(await fs.readFile(record, 'utf8')); assert.equal(restored.requestId, original.requestId); assert.equal(restored.adoptionId, original.adoptionId);
  const requests = await fs.readdir(artifacts.requestsDir).catch(error => { if (error.code === 'ENOENT') return []; throw error; });
  assert.equal(requests.filter(name => name.endsWith('.json')).length, 0);
  const assertions = { ok: true, renderer: 'webgl', actualNativeGateway: true, recordReopened: true, requestId: restored.requestId,
    adoptionId: restored.adoptionId, remoteBatchRead: process.env.KCODER_GUIDE_TUI_SOURCE_VIEWS !== '1', ownedConnectionsReleased: process.env.KCODER_GUIDE_TUI_SOURCE_VIEWS !== '1',
    sourceViewsAndExplicitDirectory: process.env.KCODER_GUIDE_TUI_SOURCE_VIEWS === '1', modelRequests: 0,
    sourceGoneInstructionPreviews: process.env.KCODER_GUIDE_TUI_INSTRUCTIONS === '1',
    sourceGonePrivateIntent: process.env.KCODER_GUIDE_TUI_PRIVATE === '1',
    sourceGoneProjectReports: process.env.KCODER_GUIDE_TUI_PROJECTS === '1',
    binarySha256: await binaryHash(), trace };
  await writeTextArtifact(path.join(artifacts.dir, 'screen.txt'), await page.evaluate(() => window.tuiLab.text()));
  await writeJsonArtifact(path.join(artifacts.dir, 'assertions.json'), assertions);
  await browser.close(); browser = undefined; await session.stop(); await session.exitPromise;
  await writeJsonArtifact(path.join(artifacts.dir, 'meta.json'), { ...assertions, ptyExit: session.getExitInfo(), diagnostics: session.getDiagnostics() });
  console.log(JSON.stringify({ ok: true, directory: artifacts.dir }));
} catch (error) { await writeFailureArtifacts({ artifacts, runOptions, command, mode: 'migration-guided-transfer-terminal', session, page, browserConsole, trace, error }); throw error; }
finally { if (browser) await browser.close(); if (session) await session.stop(); }
