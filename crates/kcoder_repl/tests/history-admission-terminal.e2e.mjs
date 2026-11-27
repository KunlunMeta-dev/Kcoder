// Real PTY/WebGL regression for an owned, externally held native history lock.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import { chromium } from '../../../tools/tui-lab/node_modules/@playwright/test/index.mjs';
import { parseArgs, defaultCommandString, browserLaunchOptions } from '../../../tools/tui-lab/lib/runner-options.mjs';
import { createRunContext } from '../../../tools/tui-lab/lib/run-context.mjs';
import { defaultWorkspaceTemplate, repoRoot, runContextRuntime } from '../../../tools/tui-lab/lib/runtime-paths.mjs';
import { startSession } from '../../../tools/tui-lab/lib/session.mjs';
import { pressTerminalEscape, submitTerminalLine, typeHumanText, waitForTerminalText, waitForComposerText } from '../../../tools/tui-lab/lib/terminal-interaction.mjs';
import { writeStartMeta, writeJsonArtifact, writeTextArtifact, writeFailureArtifacts } from '../../../tools/tui-lab/lib/runtime-artifacts.mjs';
import { attachBrowserConsole } from '../../../tools/tui-lab/lib/browser-evidence.mjs';

assert.equal(process.platform, 'linux', 'This test uses Linux flock and does not claim Windows coverage');
const options = parseArgs(['run', '--software-webgl', '--cols', '120', '--rows', '32', ...process.argv.slice(2)], { defaultWorkspaceTemplate });
assert.ok(options.description, 'Pass --description for retained evidence');
options.repoRoot = repoRoot;
options.scenario = 'busy-wait';
const binary = path.resolve(process.env.KCODER_HISTORY_ADMISSION_TUI_BINARY || path.join(repoRoot, 'target/debug/kcoder'));
const artifacts = await createRunContext(options, 'history-admission', runContextRuntime());
const quote = value => `'${value.replaceAll("'", "'\\''")}'`;
options.commandOverride = `exec ${quote(binary)} --cwd {workspace} tui-dev --scenario busy-wait`;
const runOptions = { ...options, runDir: artifacts.dir, workspaceDir: artifacts.workspace, requestsDir: artifacts.requestsDir, configHome: artifacts.configHome };
const command = defaultCommandString(runOptions);
const binarySha256 = createHash('sha256').update(await fs.readFile(binary)).digest('hex');
const scriptSha256 = createHash('sha256').update(await fs.readFile(new URL(import.meta.url))).digest('hex');
const history = path.join(artifacts.configHome, 'owned-history');
await fs.mkdir(artifacts.configDir, { recursive: true, mode: 0o700 });
await fs.mkdir(history, { recursive: true, mode: 0o700 });
await writeStartMeta(artifacts, runOptions, command, 'history-admission');
const trace = [], browserConsole = [];
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(check, description, timeout = 15000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const value = await check();
    if (value) return value;
    await delay(40);
  }
  throw new Error(`timed out: ${description}`);
}
async function requests() {
  return (await fs.readdir(artifacts.requestsDir).catch(error => error.code === 'ENOENT' ? [] : Promise.reject(error))).filter(name => name.endsWith('.json'));
}
async function originalRows(marker) {
  const rows = [];
  for (const name of (await fs.readdir(history)).filter(name => name.endsWith('.jsonl'))) {
    const content = await fs.readFile(path.join(history, name), 'utf8');
    const lines = content.split('\n');
    if (!content.endsWith('\n')) lines.pop();
    for (const line of lines.filter(Boolean)) {
      const row = JSON.parse(line);
      if (row.role === 'user' && JSON.stringify(row.content).includes(marker)) rows.push(row);
    }
  }
  return rows;
}
async function processIdentity(pid) {
  try {
    const stat = await fs.readFile(`/proc/${pid}/stat`, 'utf8');
    const fields = stat.slice(stat.lastIndexOf(')') + 2).split(' ');
    return { pid, state: fields[0], start: fields[19] };
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
}
async function processStillAlive(original) {
  const current = await processIdentity(original.pid);
  return current !== null && current.start === original.start && current.state !== 'Z';
}
let session, browser, page, locker, peer, normalSession, normalPage, hookServer, ownedHook;
let hookHttpRequests = 0;
const hookMarker = path.join(artifacts.configHome, 'session-end-hook-ran');
try {
  hookServer = createServer((request, response) => {
    hookHttpRequests += 1;
    request.resume();
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end('{}');
  });
  await new Promise((resolve, reject) => hookServer.once('error', reject).listen(0, '127.0.0.1', resolve));
  const hookPort = hookServer.address().port;
  const submitHook = path.join(artifacts.workspace, 'owned-history-submit-hook.py');
  await fs.writeFile(submitHook, `import json, os, sys, time\nrequest = json.load(sys.stdin)\nif 'QUIT-OWNED-HOOK' in request.get('prompt', ''):\n    with open('QUIT-HOOK.pid', 'w', encoding='utf-8') as f: json.dump({'pid': os.getpid()}, f)\n    while not os.path.exists('QUIT-HOOK.release'): time.sleep(0.02)\n`, { mode: 0o600 });
  await fs.writeFile(path.join(artifacts.configDir, 'settings.json'), JSON.stringify({
    provider: 'local', local_base_url: 'http://127.0.0.1:9', api_format: 'openai_chat_completions',
    model: 'fixture-model', context_window_tokens: 1000000, context_output_headroom: 10000,
    max_tokens: 2048, permission_mode: 'yolo', history_enabled: true, history_directory: history,
    hooks: { UserPromptSubmit: [{ hooks: [
      { type: 'command', command: `python3 ${quote(submitHook)}`, timeout: 30 },
    ] }], SessionEnd: [{ hooks: [
      { type: 'command', command: `printf SESSION_END_RAN > ${quote(hookMarker)}`, timeout: 3 },
      { type: 'http', url: `http://127.0.0.1:${hookPort}/session-end`, timeout: 3 },
      { type: 'prompt', prompt: 'Owned session-end prompt fixture', timeout: 3 },
      { type: 'agent', instructions: 'Owned session-end agent fixture', timeout: 3 },
    ] }] },
  }), { mode: 0o600 });
  peer = spawn('python3', ['-c', 'import time; time.sleep(120)'], { stdio: 'ignore' });
  session = await startSession(runOptions);
  browser = await chromium.launch(browserLaunchOptions(options));
  page = await browser.newPage({ viewport: { width: 1300, height: 800 } });
  attachBrowserConsole(page, browserConsole);
  await page.goto(session.url);
  await page.waitForFunction(() => window.tuiLab?.ready, null, { timeout: options.timeoutMs });
  const renderer = await page.evaluate(() => window.tuiLab.renderer);
  assert.equal(renderer, 'webgl');
  await waitForTerminalText(page, 'TUI dev mode', options.timeoutMs);
  const ready = path.join(artifacts.configHome, 'lock-ready');
  const release = path.join(artifacts.configHome, 'lock-release');
  const code = "import fcntl, os, sys, time\nf = open(sys.argv[1], 'a+b')\nfcntl.flock(f.fileno(), fcntl.LOCK_EX)\nopen(sys.argv[2], 'w').write(str(os.getpid()))\nwhile not os.path.exists(sys.argv[3]): time.sleep(0.02)\n";
  locker = spawn('python3', ['-u', '-c', code, path.join(history, '.kcoder-history.lock'), ready, release], { stdio: 'ignore' });
  await until(() => fs.access(ready).then(() => true, () => false), 'owned history lock');
  assert.equal(locker.exitCode, null);
  await submitTerminalLine(page, 'LOCKED-OWNED-FIRST');
  await waitForTerminalText(page, 'Saving input', 5000);
  const before = await requests();
  assert.equal(before.length, 0, 'model was called before the original writer ticket');
  await typeHumanText(page, 'live-draft');
  await waitForComposerText(page, 'live-draft', 2000);
  const frames = [];
  for (let index = 0; index < 8; index++) {
    frames.push(await page.evaluate(() => window.tuiLab.text()));
    await delay(110);
  }
  assert.ok(new Set(frames).size > 1, 'terminal stopped updating while the native history lock was held');
  await page.screenshot({ path: path.join(artifacts.dir, 'history-lock-responsive.png') });
  await page.evaluate(() => window.tuiLab.sendInput('\u0015'));
  await fs.writeFile(release, 'release');
  if (locker.exitCode === null) {
    await Promise.race([new Promise(resolve => locker.once('exit', resolve)), delay(5000).then(() => { throw new Error('owned lock process did not exit'); })]);
  }
  const originals = await until(async () => {
    const rows = await originalRows('LOCKED-OWNED-FIRST');
    assert.ok(rows.length <= 1, 'original input was written more than once');
    return rows.length === 1 ? rows : null;
  }, 'original accepted writer ticket settles after release');
  await until(async () => (await requests()).length === 1, 'normal input dispatched only after confirmation');
  await waitForTerminalText(page, 'busy indicator review', options.timeoutMs);
  await waitForTerminalText(page, 'tui-lab-busy-wait-final-sentinel', 25000);
  const beforeConfirmedSideQuestion = (await requests()).length;
  await submitTerminalLine(page, '/btw SIDE-CONFIRMED');
  await waitForTerminalText(page, 'SIDE-CONFIRMED', 5000);
  await until(async () => (await requests()).length === beforeConfirmedSideQuestion + 1, 'confirmed side question dispatch');
  await pressTerminalEscape(page, process.platform);
  const ready2 = path.join(artifacts.configHome, 'lock-ready-second');
  const release2 = path.join(artifacts.configHome, 'lock-release-second');
  locker = spawn('python3', ['-u', '-c', code, path.join(history, '.kcoder-history.lock'), ready2, release2], { stdio: 'ignore' });
  await until(() => fs.access(ready2).then(() => true, () => false), 'second owned history lock');
  await submitTerminalLine(page, 'LOCKED-OWNED-UNKNOWN');
  await waitForTerminalText(page, 'Saving input', 5000);
  const beforeBlockedSideQuestion = (await requests()).length;
  await submitTerminalLine(page, '/btw SIDE-BLOCKED');
  await waitForTerminalText(page, 'An input is still being saved.', 5000);
  await waitForComposerText(page, '/btw SIDE-BLOCKED', 2000);
  await delay(250);
  assert.equal((await requests()).length, beforeBlockedSideQuestion, 'side question reached Provider before input confirmation');
  await page.evaluate(() => window.tuiLab.sendInput('\u0015'));
  await submitTerminalLine(page, 'QUIT-OWNED-HOOK');
  ownedHook = await until(async () => {
    try {
      const value = JSON.parse(await fs.readFile(path.join(artifacts.workspace, 'QUIT-HOOK.pid'), 'utf8'));
      const current = await processIdentity(value.pid);
      return current && current.state !== 'Z' ? current : null;
    } catch (error) {
      if (error.code === 'ENOENT' || error instanceof SyntaxError) return null;
      throw error;
    }
  }, 'owned UserPromptSubmit Hook');
  const quittingAt = Date.now();
  process.kill(session.ptyProcess.pid, 'SIGTERM');
  const exit = await Promise.race([session.exitPromise, delay(5000).then(() => { throw new Error('TUI exit exceeded the bounded shutdown budget'); })]);
  const quitMs = Date.now() - quittingAt;
  const exitScreen = await page.evaluate(() => window.tuiLab.text());
  assert.ok(exitScreen.includes('这条输入的保存结果暂未确认') || exitScreen.includes('The save result for this input is not yet confirmed'), exitScreen);
  assert.ok(exitScreen.includes('Optional session-end actions were skipped.'), exitScreen);
  assert.ok(!exitScreen.includes('INPUT_COMMIT_UNKNOWN'), 'internal diagnostic code appeared in user interface');
  assert.equal(exit.exitCode, 0, 'interactive exit status');
  assert.equal(peer.exitCode, null, 'unrelated owned process exited');
  assert.equal(peer.signalCode, null, 'unrelated owned process was signalled');
  await until(async () => !(await processStillAlive(ownedHook)), 'owned Hook exit after cancellation', 3000);
  assert.equal(hookHttpRequests, 0, 'SessionEnd HTTP hook ran for the unconfirmed input');
  assert.equal(await fs.access(hookMarker).then(() => true, () => false), false, 'SessionEnd command hook ran for the unconfirmed input');
  await page.screenshot({ path: path.join(artifacts.dir, 'history-unknown-exit.png') });
  await fs.writeFile(release2, 'release');
  if (locker.exitCode === null) {
    await Promise.race([new Promise(resolve => locker.once('exit', resolve)), delay(5000).then(() => { throw new Error('second owned lock process did not exit'); })]);
  }
  await delay(500);
  const uncertain = await originalRows('LOCKED-OWNED-UNKNOWN');
  assert.ok(uncertain.length <= 1, 'unknown input was written more than once');
  for (const name of await requests()) {
    assert.ok(!(await fs.readFile(path.join(artifacts.requestsDir, name), 'utf8')).includes('LOCKED-OWNED-UNKNOWN'), 'unknown input was automatically dispatched');
  }
  normalSession = await startSession(runOptions);
  normalPage = await browser.newPage({ viewport: { width: 1300, height: 800 } });
  await normalPage.goto(normalSession.url);
  await normalPage.waitForFunction(() => window.tuiLab?.ready, null, { timeout: options.timeoutMs });
  await waitForTerminalText(normalPage, 'TUI dev mode', options.timeoutMs);
  process.kill(normalSession.ptyProcess.pid, 'SIGTERM');
  const normalExit = await Promise.race([normalSession.exitPromise, delay(15000).then(() => { throw new Error('normal TUI exit did not finish'); })]);
  assert.equal(normalExit.exitCode, 0, 'normal interactive exit status');
  await until(() => fs.access(hookMarker).then(() => true, () => false), 'normal SessionEnd command hook');
  await until(() => hookHttpRequests === 1, 'normal SessionEnd HTTP hook');
  await normalPage.close(); normalPage = undefined;
  await normalSession.stop(); normalSession = undefined;
  await writeTextArtifact(path.join(artifacts.dir, 'screen.txt'), await page.evaluate(() => window.tuiLab.text()));
  const assertions = { ok: true, renderer, binary, binarySha256, scriptSha256, profile: artifacts.configDir, nativeLockHeld: true, keyboardResponsive: true, changingFrames: new Set(frames).size, noPrematureProviderRequest: true, confirmedSideQuestionAllowed: true, unconfirmedSideQuestionBlocked: true, originalRows: originals.length, unknownRows: uncertain.length, unknownNotDispatched: true, unknownExitSkippedSessionEnd: true, normalExitRanSessionEnd: true, ownedHookStopped: !(await processStillAlive(ownedHook)), unrelatedPeerSurvived: peer.exitCode === null && peer.signalCode === null, quitMs, ptyExit: exit, normalExit };
  await writeJsonArtifact(path.join(artifacts.dir, 'assertions.json'), assertions);
  await browser.close(); browser = undefined;
  await session.stop(); await session.exitPromise;
  await writeJsonArtifact(path.join(artifacts.dir, 'meta.json'), { description: options.description, ...assertions, ptyExit: session.getExitInfo() });
  console.log(JSON.stringify({ ok: true, directory: artifacts.dir, assertions }, null, 2));
} catch (error) {
  await writeFailureArtifacts({ artifacts, runOptions, command, mode: 'history-admission', session, page, browserConsole, trace, error });
  throw error;
} finally {
  await fs.writeFile(path.join(artifacts.workspace, 'QUIT-HOOK.release'), 'release').catch(() => {});
  if (normalPage) await normalPage.close();
  if (normalSession) await normalSession.stop();
  if (browser) await browser.close();
  if (session) await session.stop();
  if (locker && locker.exitCode === null) {
    locker.kill('SIGTERM');
    await Promise.race([new Promise(resolve => locker.once('exit', resolve)), delay(2000)]);
  }
  if (peer && peer.exitCode === null && peer.signalCode === null) {
    peer.kill('SIGTERM');
    await Promise.race([new Promise(resolve => peer.once('exit', resolve)), delay(2000)]);
  }
  if (ownedHook && await processStillAlive(ownedHook)) {
    await until(async () => !(await processStillAlive(ownedHook)), 'owned Hook cooperative cleanup', 3000).catch(async () => {
      await writeTextArtifact(path.join(artifacts.dir, 'hook-cleanup-unconfirmed.txt'), 'The owned Hook termination could not be confirmed.');
    });
  }
  if (hookServer) {
    hookServer.closeAllConnections();
    await new Promise(resolve => hookServer.close(resolve));
  }
}
