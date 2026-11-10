// Real node-pty -> KCoder -> xterm/WebGL test with owned synthetic hooks and processes.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { chromium } from '../../../tools/tui-lab/node_modules/@playwright/test/index.mjs';
import { parseArgs, defaultCommandString, browserLaunchOptions } from '../../../tools/tui-lab/lib/runner-options.mjs';
import { createRunContext } from '../../../tools/tui-lab/lib/run-context.mjs';
import { defaultWorkspaceTemplate, repoRoot, runContextRuntime } from '../../../tools/tui-lab/lib/runtime-paths.mjs';
import { startSession } from '../../../tools/tui-lab/lib/session.mjs';
import { submitTerminalLine, typeHumanText, waitForTerminalText, waitForComposerText } from '../../../tools/tui-lab/lib/terminal-interaction.mjs';
import { writeStartMeta, writeJsonArtifact, writeTextArtifact, writeFailureArtifacts } from '../../../tools/tui-lab/lib/runtime-artifacts.mjs';
import { attachBrowserConsole } from '../../../tools/tui-lab/lib/browser-evidence.mjs';

assert.equal(process.platform, 'linux', 'This owned PTY test does not claim native Windows coverage');
const options = parseArgs(['run', '--software-webgl', '--cols', '120', '--rows', '32', ...process.argv.slice(2)], { defaultWorkspaceTemplate });
assert.ok(options.description, 'Pass --description for retained terminal evidence');
options.repoRoot = repoRoot;
options.scenario = 'busy-wait';
const binary = path.resolve(process.env.KCODER_SLOW_HOOK_TUI_BINARY || path.join(repoRoot, 'target/submit-test/debug/kcoder'));
const artifacts = await createRunContext(options, 'slow-hook', runContextRuntime());
const quote = value => `'${value.replaceAll("'", "'\\''")}'`;
options.commandOverride = `exec ${quote(binary)} --cwd {workspace} tui-dev --scenario busy-wait`;
const runOptions = { ...options, runDir: artifacts.dir, workspaceDir: artifacts.workspace, requestsDir: artifacts.requestsDir, configHome: artifacts.configHome };
const command = defaultCommandString(runOptions);
const sha256 = createHash('sha256').update(await fs.readFile(binary)).digest('hex');
const scriptSha256 = createHash('sha256').update(await fs.readFile(new URL(import.meta.url))).digest('hex');
await fs.mkdir(artifacts.configDir, { recursive: true, mode: 0o700 });
const fixture = path.join(artifacts.workspace, 'owned-submit-hook.py');
await fs.writeFile(fixture, `import json, os, sys, time\nrequest = json.load(sys.stdin)\nprompt = request.get('prompt', '')\nfor name in ('SECOND', 'CLEAR', 'EXIT'):\n    if name + '-OWNED' in prompt:\n        with open(name + '.pid', 'w', encoding='utf-8') as f:\n            json.dump({'pid': os.getpid(), 'group': os.getpgrp()}, f)\n        while not os.path.exists(name + '.release'):\n            time.sleep(0.02)\n        break\n`, { mode: 0o600 });
await fs.writeFile(path.join(artifacts.configDir, 'settings.json'), JSON.stringify({
  provider: 'local', local_base_url: 'http://127.0.0.1:9', api_format: 'openai_chat_completions',
  model: 'fixture-model', context_window_tokens: 1000000, context_output_headroom: 10000,
  max_tokens: 2048, permission_mode: 'yolo',
  hooks: { UserPromptSubmit: [{ hooks: [{ type: 'command', command: `python3 ${quote(fixture)}`, timeout: 30 }] }] },
}), { mode: 0o600 });
await writeStartMeta(artifacts, runOptions, command, 'slow-hook');
const trace = [], browserConsole = [], ownedHooks = [];
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(check, label, timeout = 15000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const result = await check();
    if (result) return result;
    await delay(40);
  }
  throw new Error(`timed out: ${label}`);
}
async function identity(pid) {
  try {
    const stat = await fs.readFile(`/proc/${pid}/stat`, 'utf8');
    const fields = stat.slice(stat.lastIndexOf(')') + 2).split(' ');
    return { pid, state: fields[0], start: fields[19] };
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
}
async function alive(original) {
  const current = await identity(original.pid);
  return current !== null && current.start === original.start && current.state !== 'Z';
}
async function hook(name) {
  const file = path.join(artifacts.workspace, `${name}.pid`);
  return until(async () => {
    try {
      const value = JSON.parse(await fs.readFile(file, 'utf8'));
      const observed = await identity(value.pid);
      if (!observed || observed.state === 'Z') return null;
      const groupOwner = await identity(value.group);
      assert.ok(groupOwner && groupOwner.state !== 'Z', 'owned hook group leader unavailable');
      const owner = { ...observed, group: value.group, groupOwner };
      ownedHooks.push(owner);
      return owner;
    } catch (error) {
      if (error.code === 'ENOENT' || error instanceof SyntaxError) return null;
      throw error;
    }
  }, `${name} hook identity`);
}
async function requestContaining(first, second) {
  return until(async () => {
    const names = await fs.readdir(artifacts.requestsDir).catch(error => error.code === 'ENOENT' ? [] : Promise.reject(error));
    for (const name of names.filter(value => value.endsWith('.json')).sort()) {
      const request = JSON.parse(await fs.readFile(path.join(artifacts.requestsDir, name), 'utf8'));
      const users = request.body.messages.filter(message => message.role === 'user').map(message => JSON.stringify(message.content));
      const a = users.findIndex(value => value.includes(first));
      const b = users.findIndex(value => value.includes(second));
      const toolCompleted = request.body.messages.some(message => JSON.stringify(message.content).includes('tui-lab-busy-wait-end'));
      if (a >= 0 && b > a && toolCompleted) return { name, first: a, second: b, toolCompleted };
    }
    return null;
  }, 'ordered original and steering inputs in a real model request', 30000);
}
let session, browser, page;
const peer = spawn('sleep', ['120'], { stdio: 'ignore' });
try {
  session = await startSession(runOptions);
  browser = await chromium.launch(browserLaunchOptions(options));
  page = await browser.newPage({ viewport: { width: 1300, height: 800 } });
  attachBrowserConsole(page, browserConsole);
  await page.goto(session.url);
  await page.waitForFunction(() => window.tuiLab?.ready, null, { timeout: options.timeoutMs });
  const renderer = await page.evaluate(() => window.tuiLab.renderer);
  assert.equal(renderer, 'webgl');
  await waitForTerminalText(page, 'TUI dev mode', options.timeoutMs);
  await submitTerminalLine(page, 'FIRST-OWNED');
  await waitForTerminalText(page, 'busy indicator review', options.timeoutMs);
  await submitTerminalLine(page, 'SECOND-OWNED');
  const second = await hook('SECOND');
  const frames = [];
  for (let index = 0; index < 8; index++) {
    frames.push(await page.evaluate(() => window.tuiLab.text()));
    await delay(110);
  }
  const indicators = frames.map(text => text.split('\n').find(line => line.includes('busy indicator review') && line.includes('interrupt'))?.match(/[▁▃▆█]{4}/)?.[0]).filter(Boolean);
  assert.ok(indicators.length >= 4 && new Set(indicators).size > 1, `tool activity indicator did not animate: ${JSON.stringify(indicators)}`);
  await typeHumanText(page, 'live-draft');
  await waitForComposerText(page, 'live-draft', 2000);
  await page.screenshot({ path: path.join(artifacts.dir, 'slow-hook-responsive.png') });
  await page.evaluate(() => window.tuiLab.sendInput('\u0015'));
  await fs.writeFile(path.join(artifacts.workspace, 'SECOND.release'), 'release');
  await until(async () => !(await alive(second)), 'second hook exit');
  await submitTerminalLine(page, 'CLEAR-OWNED');
  const clear = await hook('CLEAR');
  await submitTerminalLine(page, '/queue clear');
  await waitForTerminalText(page, 'Cleared 1 queued prompt', 5000);
  await until(async () => !(await alive(clear)), 'cleared hook exit');
  assert.equal(peer.exitCode, null, 'unrelated owned peer must survive queue clearing');
  const ordered = await requestContaining('FIRST-OWNED', 'SECOND-OWNED');
  await page.screenshot({ path: path.join(artifacts.dir, 'slow-hook-ordered.png') });
  await submitTerminalLine(page, 'EXIT-OWNED');
  const exitHook = await hook('EXIT');
  process.kill(session.ptyProcess.pid, 'SIGTERM');
  const exit = await Promise.race([session.exitPromise, delay(10000).then(() => { throw new Error('owned TUI did not exit'); })]);
  await until(async () => !(await alive(exitHook)), 'exit hook cleanup');
  assert.equal(peer.exitCode, null, 'unrelated owned peer must survive TUI exit');
  await writeTextArtifact(path.join(artifacts.dir, 'screen.txt'), await page.evaluate(() => window.tuiLab.text()));
  const assertions = { ok: true, renderer, binary, sha256, scriptSha256, profile: artifacts.configDir, ordered, keyboardDuringHook: true, indicators, queueClearStoppedHook: true, runningToolSurvivedClear: true, exitStoppedHook: true, peerSurvived: true, ptyExit: exit };
  await writeJsonArtifact(path.join(artifacts.dir, 'assertions.json'), assertions);
  await writeJsonArtifact(path.join(artifacts.dir, 'meta.json'), { description: options.description, ...assertions });
  console.log(JSON.stringify({ ok: true, directory: artifacts.dir, assertions }, null, 2));
} catch (error) {
  await writeFailureArtifacts({ artifacts, runOptions, command, mode: 'slow-hook', session, page, browserConsole, trace, error });
  throw error;
} finally {
  if (browser) await browser.close();
  if (session) await session.stop();
  for (const owner of ownedHooks) {
    if (await alive(owner) && owner.group > 1 && await alive(owner.groupOwner)) {
      try { process.kill(-owner.group, 'SIGKILL'); } catch (error) { if (error.code !== 'ESRCH') throw error; }
    }
  }
  if (peer.exitCode === null) {
    peer.kill('SIGTERM');
    await Promise.race([new Promise(resolve => peer.once('exit', resolve)), delay(2000)]);
  }
}
