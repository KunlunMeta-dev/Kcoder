// Real PTY regression for clearing an already accepted but unconfirmed input.
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
import { submitTerminalLine, typeHumanText, waitForComposerText, waitForTerminalText, waitForTerminalTextMissing } from '../../../tools/tui-lab/lib/terminal-interaction.mjs';
import { writeStartMeta, writeJsonArtifact, writeTextArtifact, writeFailureArtifacts } from '../../../tools/tui-lab/lib/runtime-artifacts.mjs';
import { attachBrowserConsole } from '../../../tools/tui-lab/lib/browser-evidence.mjs';

assert.equal(process.platform, 'linux', 'This test uses an owned Linux flock');
const options = parseArgs(['run', '--software-webgl', '--cols', '120', '--rows', '32', ...process.argv.slice(2)], { defaultWorkspaceTemplate });
const newSessionDuringLock = process.env.KCODER_QUEUE_CLEAR_NEW_SESSION === '1';
assert.ok(options.description);
options.repoRoot = repoRoot;
options.scenario = 'busy-wait';
const binary = path.resolve(process.env.KCODER_QUEUE_CLEAR_TUI_BINARY);
const artifacts = await createRunContext(options, 'queue-clear-admission', runContextRuntime());
const quote = value => `'${value.replaceAll("'", "'\\''")}'`;
options.commandOverride = `exec ${quote(binary)} --cwd {workspace} tui-dev --scenario busy-wait`;
const runOptions = { ...options, runDir: artifacts.dir, workspaceDir: artifacts.workspace, requestsDir: artifacts.requestsDir, configHome: artifacts.configHome };
const command = defaultCommandString(runOptions);
const binarySha256 = createHash('sha256').update(await fs.readFile(binary)).digest('hex');
const scriptSha256 = createHash('sha256').update(await fs.readFile(new URL(import.meta.url))).digest('hex');
const history = path.join(artifacts.configHome, 'owned-history');
const hookMarker = path.join(artifacts.configHome, 'session-end-hook-ran');
await fs.mkdir(artifacts.configDir, { recursive: true, mode: 0o700 });
await fs.mkdir(history, { recursive: true, mode: 0o700 });
await fs.writeFile(path.join(artifacts.configDir, 'settings.json'), JSON.stringify({
  provider: 'local', local_base_url: 'http://127.0.0.1:9', api_format: 'openai_chat_completions',
  model: 'fixture-model', context_window_tokens: 1000000, context_output_headroom: 10000,
  max_tokens: 2048, permission_mode: 'yolo', history_enabled: true, history_directory: history,
  hooks: { SessionEnd: [{ hooks: [
    { type: 'command', command: `printf SESSION_END_RAN > ${quote(hookMarker)}`, timeout: 3 },
    { type: 'prompt', prompt: 'Owned session-end prompt fixture', timeout: 3 },
    { type: 'agent', instructions: 'Owned session-end agent fixture', timeout: 3 },
  ] }] },
}), { mode: 0o600 });
await writeStartMeta(artifacts, runOptions, command, 'queue-clear-admission');
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
  return (await fs.readdir(artifacts.requestsDir).catch(error => error.code === 'ENOENT' ? [] : Promise.reject(error))).filter(name => name.endsWith('.json')).sort();
}
async function historyRows(marker) {
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
const trace = [], browserConsole = [];
let session, browser, page, locker, peer;
try {
  peer = spawn('python3', ['-c', 'import time; time.sleep(120)'], { stdio: 'ignore' });
  session = await startSession(runOptions);
  browser = await chromium.launch(browserLaunchOptions(options));
  page = await browser.newPage({ viewport: { width: 1300, height: 800 } });
  attachBrowserConsole(page, browserConsole);
  await page.goto(session.url);
  await page.waitForFunction(() => window.tuiLab?.ready, null, { timeout: options.timeoutMs });
  assert.equal(await page.evaluate(() => window.tuiLab.renderer), 'webgl');
  await waitForTerminalText(page, 'TUI dev mode', options.timeoutMs);
  const ready = path.join(artifacts.configHome, 'lock-ready');
  const release = path.join(artifacts.configHome, 'lock-release');
  const code = "import fcntl, os, sys, time\nf = open(sys.argv[1], 'a+b')\nfcntl.flock(f.fileno(), fcntl.LOCK_EX)\nopen(sys.argv[2], 'w').write(str(os.getpid()))\nwhile not os.path.exists(sys.argv[3]): time.sleep(0.02)\n";
  locker = spawn('python3', ['-u', '-c', code, path.join(history, '.kcoder-history.lock'), ready, release], { stdio: 'ignore' });
  await until(() => fs.access(ready).then(() => true, () => false), 'owned history lock');
  await submitTerminalLine(page, 'CLEAR-FIRST-OWNED');
  await waitForTerminalText(page, 'Saving input', 5000);
  assert.equal((await requests()).length, 0);
  await submitTerminalLine(page, '/queue clear');
  await waitForTerminalText(page, 'Cleared 1 queued prompt(s).', 5000);
  let framesWhileLocked;
  if (newSessionDuringLock) {
    await submitTerminalLine(page, '/new');
    await typeHumanText(page, 'LIVE-DRAFT-OWNED');
    await waitForComposerText(page, 'LIVE-DRAFT-OWNED', 3000);
    framesWhileLocked = [];
    for (let i = 0; i < 8; i++) {
      framesWhileLocked.push(await page.evaluate(() => window.tuiLab.text()));
      await delay(110);
    }
    assert.ok(new Set(framesWhileLocked).size > 1, 'UI frames stopped while the shared history lock was held');
    assert.ok(!framesWhileLocked.at(-1).includes('Conversation cleared.'), 'new session falsely reported while the lock was held');
    assert.equal((await requests()).length, 0, 'Provider called while shared history lock was held');
    assert.equal(peer.exitCode, null, 'unrelated peer exited');
    await page.screenshot({ path: path.join(artifacts.dir, 'session-lock-responsive.png') });
  }
  await fs.writeFile(release, 'release');
  await Promise.race([new Promise(resolve => locker.once('exit', resolve)), delay(5000).then(() => { throw new Error('owned lock did not exit'); })]);
  const firstRows = await until(async () => {
    const rows = await historyRows('CLEAR-FIRST-OWNED');
    assert.ok(rows.length <= 1, 'first input persisted more than once');
    return rows.length === 1 ? rows : null;
  }, 'first accepted input persisted');
  await waitForTerminalTextMissing(page, 'Saving input', 5000);
  if (newSessionDuringLock) {
    await waitForTerminalText(page, 'Conversation cleared.', 10000);
    await page.evaluate(() => window.tuiLab.sendInput('\u0015'));
  }
  const beforeSecond = await page.evaluate(() => window.tuiLab.text());
  await submitTerminalLine(page, 'FOLLOWUP-SECOND-OWNED');
  let request = '';
  if (newSessionDuringLock) {
    const names = await until(async () => (await requests()).length ? await requests() : null, 'follow-up Provider request', 15000);
    request = await fs.readFile(path.join(artifacts.requestsDir, names[0]), 'utf8');
  } else {
    await waitForComposerText(page, 'FOLLOWUP-SECOND-OWNED', 3000);
    await delay(500);
    assert.equal((await requests()).length, 0, 'cancelled input reached a Provider');
    await page.evaluate(() => window.tuiLab.sendInput('\u0015'));
    await submitTerminalLine(page, '/btw SIDE-MUST-NOT-RUN');
    await waitForComposerText(page, '/btw SIDE-MUST-NOT-RUN', 3000);
    await delay(250);
    assert.equal((await requests()).length, 0, 'side question bypassed the cancelled-input barrier');
  }
  const screen = await page.evaluate(() => window.tuiLab.text());
  const observation = {
    binarySha256, scriptSha256, firstHistoryUuid: firstRows[0].uuid,
    requestHasFirst: request.includes('CLEAR-FIRST-OWNED'),
    requestHasSecond: request.includes('FOLLOWUP-SECOND-OWNED'),
    visibleFirstBeforeSecond: beforeSecond.includes('CLEAR-FIRST-OWNED'),
    visibleFirstAfterSecond: screen.includes('CLEAR-FIRST-OWNED'),
    peerSurvived: peer.exitCode === null && peer.signalCode === null,
    newSessionDuringLock,
    framesWhileLocked: framesWhileLocked ? new Set(framesWhileLocked).size : undefined,
  };
  await writeTextArtifact(path.join(artifacts.dir, 'screen.txt'), screen);
  await page.screenshot({ path: path.join(artifacts.dir, 'queue-clear-observation.png') });
  assert.ok(observation.firstHistoryUuid);
  if (newSessionDuringLock) {
    assert.ok(observation.requestHasSecond && !observation.requestHasFirst, 'new session request included the old input');
    assert.ok(!observation.visibleFirstBeforeSecond && !observation.visibleFirstAfterSecond, 'old input appeared in the new session');
  } else {
    assert.ok(!observation.requestHasFirst && !observation.requestHasSecond, 'blocked input reached a Provider');
    assert.ok(observation.visibleFirstBeforeSecond && observation.visibleFirstAfterSecond, 'cancelled input was hidden');
  }
  assert.ok(observation.peerSurvived);
  if (!newSessionDuringLock) {
    process.kill(session.ptyProcess.pid, 'SIGTERM');
    const exit = await Promise.race([session.exitPromise, delay(5000).then(() => { throw new Error('owned TUI did not exit'); })]);
    assert.equal(exit.exitCode, 0, 'interactive exit status');
    assert.equal((await requests()).length, 0, 'session-end work called a Provider');
    assert.equal(await fs.access(hookMarker).then(() => true, () => false), false, 'session-end command Hook ran');
    await waitForTerminalText(page, 'This input was not sent and may already be saved.', 3000);
    await waitForTerminalText(page, 'Optional session-end actions were skipped.', 3000);
    const exitScreen = await page.evaluate(() => window.tuiLab.text());
    assert.ok(exitScreen.includes('This input was not sent and may already be saved.'), exitScreen);
    assert.ok(exitScreen.includes('Optional session-end actions were skipped.'), exitScreen);
    assert.equal(peer.exitCode, null, 'unrelated peer exited during TUI shutdown');
    assert.equal(peer.signalCode, null, 'unrelated peer was signalled during TUI shutdown');
    process.kill(peer.pid, 0);
    await page.screenshot({ path: path.join(artifacts.dir, 'cancelled-input-exit.png') });
    observation.sessionEndSkipped = true;
    observation.peerSurvivedExit = true;
    observation.ptyExit = exit;
  }
  await writeJsonArtifact(path.join(artifacts.dir, 'observation.json'), observation);
  console.log(JSON.stringify({ ok: true, directory: artifacts.dir, observation }, null, 2));
} catch (error) {
  await writeFailureArtifacts({ artifacts, runOptions, command, mode: 'queue-clear-admission', session, page, browserConsole, trace, error });
  throw error;
} finally {
  await fs.writeFile(path.join(artifacts.configHome, 'lock-release'), 'release').catch(() => {});
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
}
