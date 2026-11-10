// Actual node-pty/xterm WebGL reviews one disabled Agent plan without invoking a model.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { chromium } from '../../../tools/tui-lab/node_modules/@playwright/test/index.mjs';
import { parseArgs, defaultCommandString, browserLaunchOptions } from '../../../tools/tui-lab/lib/runner-options.mjs';
import { createRunContext } from '../../../tools/tui-lab/lib/run-context.mjs';
import { defaultWorkspaceTemplate, repoRoot, runContextRuntime } from '../../../tools/tui-lab/lib/runtime-paths.mjs';
import { startSession } from '../../../tools/tui-lab/lib/session.mjs';
import { typeHumanText, waitForTerminalText } from '../../../tools/tui-lab/lib/terminal-interaction.mjs';
import { writeStartMeta, writeJsonArtifact, writeTextArtifact, writeFailureArtifacts } from '../../../tools/tui-lab/lib/runtime-artifacts.mjs';
import { attachBrowserConsole } from '../../../tools/tui-lab/lib/browser-evidence.mjs';

assert.equal(process.platform, 'linux', 'This fixture proves the Linux terminal only.');
const options = parseArgs(['run', '--software-webgl', '--cols', '175', '--rows', '80', ...process.argv.slice(2)], { defaultWorkspaceTemplate });
assert.ok(options.description, 'Pass --description for actual terminal evidence.'); options.repoRoot = repoRoot;
const artifacts = await createRunContext(options, 'migration-agent-terminal', runContextRuntime());
const binary = path.join(artifacts.configHome, 'owned-bin/kcoder');
await fs.mkdir(path.dirname(binary), { recursive: true, mode: 0o700 });
await fs.copyFile(process.env.KCODER_MIGRATION_TUI_BINARY || path.join(repoRoot, 'target/debug/kcoder'), binary); await fs.chmod(binary, 0o700);
options.commandOverride = `exec '${binary.replaceAll("'", "'\\''")}' --cwd {workspace} tui-dev --scenario full-turn`;
const runOptions = { ...options, runDir: artifacts.dir, workspaceDir: artifacts.workspace, requestsDir: artifacts.requestsDir, configHome: artifacts.configHome };
const command = defaultCommandString(runOptions); await writeStartMeta(artifacts, runOptions, command, 'migration-agent-terminal');
const home = path.join(artifacts.workspace, 'owned-agent-source'), product = path.join(home, '.claude');
await fs.mkdir(path.join(product, 'agents'), { recursive: true, mode: 0o700 });
const body = '---\nname: review\ndescription: Read only\ntools: Read, Write\ndisallowedTools: Write\nmodel: unresolved-source-alias\n---\nPTY_AGENT_ORIGINAL_BODY do not execute.\n';
const sha256 = createHash('sha256').update(body).digest('hex');
await fs.writeFile(path.join(product, 'agents/review.md'), body, { mode: 0o600 });
await fs.writeFile(path.join(product, 'settings.json'), '{}', { mode: 0o600 });
await fs.mkdir(artifacts.configDir, { recursive: true, mode: 0o700 });
const settings = JSON.stringify({ provider: 'local', local_base_url: 'http://127.0.0.1:9', api_format: 'openai_chat_completions', model: 'fixture-model', credential_store: 'file' });
await fs.writeFile(path.join(artifacts.configDir, 'settings.json'), settings, { mode: 0o600 });
let session, browser, page, current = ''; const trace = [], browserConsole = [];
async function send(text) { await page.evaluate(() => window.tuiLab.focus()); await typeHumanText(page, text); await page.evaluate(() => window.tuiLab.sendInput('\r')); }
async function question(label) {
  await page.waitForFunction(previous => {
    const ids = Array.from(window.tuiLab.text().matchAll(/\/migrate answer ([a-f0-9]{12,32})/g));
    return ids.length && ids.at(-1)[1] !== previous;
  }, current, { timeout: 30000 });
  const text = await page.evaluate(() => window.tuiLab.text());
  assert.ok(!text.includes('本地迁移未完成'), text);
  const labels = Array.from(text.matchAll(/当前问题：([^\n┃│]+)/g)); assert.equal(labels.at(-1)?.[1].trim(), label, text);
  current = Array.from(text.matchAll(/\/migrate answer ([a-f0-9]{12,32})/g)).at(-1)[1]; trace.push({ label }); return text;
}
async function answer(value) { await send(`/migrate answer ${current} ${JSON.stringify(value)}`); }
const native = args => JSON.parse(execFileSync(binary, ['--cwd', artifacts.workspace, 'migrate', ...args], {
  encoding: 'utf8', timeout: 30000, maxBuffer: 2 * 1024 * 1024,
  env: { PATH: process.env.PATH, HOME: artifacts.configHome, USERPROFILE: artifacts.configHome, KCODER_CONFIG_DIR: artifacts.configDir, KCODER_TUI_LAB_REQUEST_DIR: artifacts.requestsDir },
}));
try {
  session = await startSession(runOptions); browser = await chromium.launch({ ...browserLaunchOptions(options), executablePath: process.env.KCODER_GUIDE_TUI_CHROMIUM || undefined });
  page = await browser.newPage({ viewport: { width: 1700, height: 1500 } }); attachBrowserConsole(page, browserConsole);
  await page.goto(session.url); await page.waitForFunction(() => window.tuiLab?.ready, null, { timeout: options.timeoutMs });
  await waitForTerminalText(page, 'TUI dev mode', options.timeoutMs); assert.equal(await page.evaluate(() => window.tuiLab.renderer), 'webgl');
  await send(`/migrate configure --source claude-code --source-home "${home}" --include-definitions`);
  await question('选择设置写入范围'); await answer('user');
  await question('选择待处理Agent/Hook来源'); await answer('toggle 1');
  await question('选择待处理Agent/Hook来源'); await answer('done');
  await question('选择操作'); await answer('select');
  const selection = await question('选择迁移项目');
  const agent = Array.from(selection.matchAll(/^\s*(\d+)\. \[[ x]\] 待处理Agent定义 /gm)).at(-1);
  assert.ok(agent, selection); await answer(`toggle ${agent[1]}`);
  await question('设置目标名称'); await answer('pty-reviewed-agent');
  await question('明确选择静态Agent适配'); await answer('yes');
  const review = await question('检查原Agent定义'); assert.ok(review.includes(sha256)); assert.ok(!review.includes('PTY_AGENT_ORIGINAL_BODY')); await answer('no');
  await question('选择Agent模型策略'); await answer('inherit');
  const tools = await question('选择原定义允许的工具'); assert.match(tools, /"selected":\s*0/); assert.match(tools, /"tool":\s*"read"/); assert.ok(!tools.includes('"tool": "write"'));
  await page.screenshot({ path: path.join(artifacts.dir, 'agent-default-empty-tools.png') }); await answer('toggle 1');
  await question('选择原定义允许的工具'); await answer('done');
  await question('确认所审查原件SHA256'); await answer(sha256);
  await question('选择迁移项目'); await answer('preview');
  await question('确认已有结果复用'); await answer('no');
  await question('选择操作'); await page.screenshot({ path: path.join(artifacts.dir, 'agent-disabled-plan.png') }); await answer('quit');
  await waitForTerminalText(page, '本地迁移向导已退出', 15000);
  const records = native(['records', '--target-profile', artifacts.configDir]); assert.equal(records.jobs.length, 1);
  const jobId = records.jobs[0].job.jobId;
  const state = native(['status', '--target-profile', artifacts.configDir, '--job-id', jobId]); assert.equal(state.job.status, 'ready'); assert.ok(state.batch.planId);
  const items = native(['items', '--target-profile', artifacts.configDir, '--job-id', jobId]); assert.equal(items.planned.length, 1); assert.equal(items.planned[0].enabled, false);
  assert.equal(await fs.access(path.join(artifacts.configDir, 'skills/pty-reviewed-agent')).then(() => true, () => false), false);
  assert.equal(await fs.readFile(path.join(product, 'agents/review.md'), 'utf8'), body); assert.equal(await fs.readFile(path.join(artifacts.configDir, 'settings.json'), 'utf8'), settings);
  const requests = await fs.readdir(artifacts.requestsDir).catch(error => { if (error.code === 'ENOENT') return []; throw error; }); assert.equal(requests.filter(name => name.endsWith('.json')).length, 0);
  const assertions = { ok: true, renderer: 'webgl', jobId, originalSha256: sha256, disabledPlan: true, published: false, modelRequests: 0, sourceUnchanged: true, selectedCanonicalTools: ['read'], binarySha256: createHash('sha256').update(await fs.readFile(binary)).digest('hex'), trace };
  await writeTextArtifact(path.join(artifacts.dir, 'screen.txt'), await page.evaluate(() => window.tuiLab.text())); await writeJsonArtifact(path.join(artifacts.dir, 'assertions.json'), assertions);
  await browser.close(); browser = undefined; await session.stop(); await session.exitPromise;
  await writeJsonArtifact(path.join(artifacts.dir, 'meta.json'), { ...assertions, ptyExit: session.getExitInfo(), diagnostics: session.getDiagnostics() }); console.log(JSON.stringify({ ok: true, directory: artifacts.dir }));
} catch (error) { await writeFailureArtifacts({ artifacts, runOptions, command, mode: 'migration-agent-terminal', session, page, browserConsole, trace, error }); throw error; }
finally {
  if (browser) await browser.close();
  if (session) {
    await session.stop(); await session.exitPromise;
    await writeJsonArtifact(path.join(artifacts.dir, 'cleanup.json'), { ptyExit: session.getExitInfo(), diagnostics: session.getDiagnostics() });
  }
}
