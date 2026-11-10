import { chromium } from '../../renderer/node_modules/@playwright/test/index.mjs';
import { constants, createReadStream } from 'node:fs';
import { access, mkdir, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { createHash, randomBytes } from 'node:crypto';
import { basename, dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { RunContext, repoRoot, retainedArtifactRunRoot, waitFor } from './run-context.mjs';
import { startGateway, waitForGatewayRpcToken } from './gateway.mjs';
import { login } from './http.mjs';
import { startApprovalModelFixture } from './approval-model.mjs';
import { materializeWorkspace } from './workspace-fixture.mjs';
import { buildAiVerifyGatewayEnvironment } from '../../renderer/scripts/ai-verify-environment.mjs';

const metadata = {
  testId: 'ai-verify-owned-electron-gateway',
  modelPolicy: 'model-independent',
  retainSuccessEvidence: true,
  evidenceReason: 'Explicit real Electron verification with an owned display',
};


export function parseOwnedWindowSize(value) {
  const match = typeof value === 'string' && value.match(/^(\d{3,4})x(\d{3,4})$/);
  if (!match) throw new Error('Window size must be WIDTHxHEIGHT');
  const width = Number(match[1]), height = Number(match[2]);
  if (width < 320 || width > 1280 || height < 240 || height > 900) {
    throw new Error('Window size exceeds the owned display bounds');
  }
  return { width, height };
}
export function parseOwnedPointerDrag(value) {
  const match = typeof value === 'string' && value.match(/^(\d+),(\d+):(\d+),(\d+)$/);
  if (!match) throw new Error('Drag must be x,y:x,y');
  const values = match.slice(1).map(Number);
  if (values.some((value,index) => value < 0 || value >= (index % 2 === 0 ? 1280 : 900))) throw new Error('Drag exceeds owned display bounds');
  return values;
}

export async function gatewayVerificationOptions(options) {
  if (process.platform !== 'linux') throw new Error('Owned-display Gateway verification currently requires Linux');
  const allowed = new Set(['gateway', 'electron-bin', 'kcoder-bin', 'renderer-root', 'timeout', 'scenario', 'provider-fixture', 'continuation-fixture', 'drop-save-reply', 'drop-steer-reply', 'delay-cancel-reply', 'delay-workspace-file-reply', 'ui-receipt-fault']);
  if (Object.keys(options).some(name => !allowed.has(name))) {
    throw new Error('Unknown Gateway verification option; external origins, tokens and displays are not accepted');
  }
  if (options['provider-fixture'] !== undefined && options['provider-fixture'] !== 'true') throw new Error('Provider fixture must be explicitly enabled with true');
  if (options['delay-cancel-reply'] !== undefined && options['delay-cancel-reply'] !== 'true') throw new Error('Cancel reply delay must be explicitly enabled');
  if (options['delay-workspace-file-reply'] !== undefined && options['delay-workspace-file-reply'] !== 'true') throw new Error('Workspace file reply delay must be explicitly enabled');
  if (options['ui-receipt-fault'] !== undefined && options['ui-receipt-fault'] !== 'true') throw new Error('UI receipt faults must be explicitly enabled');
  if (options['drop-steer-reply'] !== undefined && options['drop-steer-reply'] !== 'true') throw new Error('Steer reply fault must be explicitly enabled with true');
  if (options['drop-save-reply'] !== undefined && options['drop-save-reply'] !== 'true') throw new Error('Save reply fault must be explicitly enabled with true');
  if (options['continuation-fixture'] !== undefined && options['continuation-fixture'] !== 'true') throw new Error('Continuation fixture must be explicitly enabled with true');
  if (options['continuation-fixture'] && (options.scenario || options['provider-fixture'])) throw new Error('Continuation fixture cannot be combined with another fixture');
  if (options.scenario && options.scenario !== 'subagent-trace') throw new Error('Unsupported owned Gateway verification scenario');
  for (const name of ['electron-bin', 'kcoder-bin', 'renderer-root']) {
    if (!options[name]) throw new Error(`Gateway verification requires --${name}`);
  }
  const electronBin = await realpath(resolve(options['electron-bin']));
  const kcoderBin = await realpath(resolve(options['kcoder-bin']));
  const rendererRoot = await realpath(resolve(options['renderer-root']));
  await Promise.all([
    access(electronBin, constants.X_OK), access(kcoderBin, constants.X_OK),
    access(join(rendererRoot, 'index.html'), constants.R_OK),
    access('/usr/bin/Xvfb', constants.X_OK),
    access('/usr/bin/git', constants.X_OK),
  ]);
  return { electronBin, kcoderBin, rendererRoot, noSandbox: process.env.KCODER_E2E_CHROMIUM_NO_SANDBOX === '1', scenario: options.scenario, providerFixture: options['provider-fixture'] === 'true', continuationFixture: options['continuation-fixture'] === 'true', dropSaveReply: options['drop-save-reply'] === 'true', dropSteerReply: options['drop-steer-reply'] === 'true', delayCancelReply: options['delay-cancel-reply'] === 'true', delayWorkspaceFileReply: options['delay-workspace-file-reply'] === 'true', uiReceiptFault: options['ui-receipt-fault'] === 'true' };
}

export async function createGatewayVerificationRun() {
  return RunContext.create(import.meta.url, metadata);
}

export async function resumeGatewayVerificationRun(runRoot, token) {
  const source = fileURLToPath(import.meta.url);
  const sourceRelative = relative(repoRoot, source);
  const canonicalRoot = await realpath(runRoot);
  const runId = basename(canonicalRoot);
  if (!/^\d{8}-\d{6}\.\d{3}Z(?:-p\d+-\d+-[a-f0-9]+)?$/.test(runId) ||
      retainedArtifactRunRoot(source, runId) !== canonicalRoot) {
    throw new Error('Gateway verification controller can only resume its owned run directory');
  }
  const manifest = JSON.parse(await readFile(join(canonicalRoot, 'manifest.json'), 'utf8'));
  if (manifest.source !== sourceRelative || manifest.status !== 'running') {
    throw new Error('Gateway verification run is not available for controller handoff');
  }
  const context = new RunContext(source, sourceRelative, canonicalRoot, metadata);
  await context.initialize();
  context.registerSecret(token);
  return context;
}

export function xauthorityRecord(display, cookie) {
  if (!/^\d{1,5}$/.test(display) || !Buffer.isBuffer(cookie) || cookie.length !== 16) {
    throw new Error('Invalid owned X display authorization');
  }
  const field = value => {
    const bytes = Buffer.isBuffer(value) ? value : Buffer.from(value);
    const length = Buffer.alloc(2);
    length.writeUInt16BE(bytes.length);
    return Buffer.concat([length, bytes]);
  };
  return Buffer.concat([
    Buffer.from([255, 255]), field(''), field(display), field('MIT-MAGIC-COOKIE-1'), field(cookie),
  ]);
}

export async function startOwnedDisplay(context, { startupTimeoutMs = 10_000 } = {}) {
  const cookie = randomBytes(16);
  context.registerSecret(cookie.toString('hex'));
  const authority = context.pathInState('display.xauthority');
  await writeFile(authority, xauthorityRecord('0', cookie), { mode: 0o600, flag: 'wx' });
  const child = context.spawnOwned('electron-display', '/usr/bin/Xvfb', [
    '-displayfd', '1', '-screen', '0', '1280x900x24', '-nolisten', 'tcp', '-auth', authority,
  ]);
  let output = '';
  child.stdout.on('data', chunk => { output += chunk.toString(); });
  const number = await waitFor(() => {
    if (child.exitCode !== null) throw new Error('Owned Xvfb exited before allocating a display');
    return output.match(/^(\d+)\r?$/m)?.[1];
  }, startupTimeoutMs, 'owned Xvfb display', 50);
  await writeFile(authority, xauthorityRecord(number, cookie), { mode: 0o600 });
  return { display: `:${number}`, authority, child };
}

export async function prepareGatewayWorkspace(context) {
  const { path: workspace } = await materializeWorkspace(context, 'rust-project', {
    instanceId: 'electron-verification',
  });
  const child = context.spawnOwned('electron-workspace-git', '/usr/bin/git', [
    '-c', 'init.templateDir=', 'init', '--initial-branch=main', workspace,
  ], { env: context.isolatedEnvironment({ GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null' }) });
  await waitFor(() => child.exitCode !== null, 10_000, 'owned workspace Git boundary');
  if (child.exitCode !== 0) throw new Error('Failed to create owned workspace Git boundary');
  return workspace;
}

export async function launchGatewayVerification(context, options, { controlUrl, token }) {
  const workspace = await prepareGatewayWorkspace(context);
  if (options.providerFixture) {
    const fixture = await startApprovalModelFixture(context, { textOnly: true });
    await context.writeArtifactJson('provider-fixture.json', { endpoint: fixture.baseUrl.replace('127.0.0.1', 'localhost.') });
  }
  const configDirectory = context.pathInState('kcoder-home');
  await mkdir(configDirectory);
  // An empty explicit model catalogue prevents accidental default-provider network calls.
  if (!options.continuationFixture) await context.writeStateJson('kcoder-home/settings.json', { credential_store: 'file', providers: {}, ...(options.scenario ? { model: 'tui-dev-mock', context_window_tokens: 200000, context_output_headroom: 20000, max_tokens: 4096 } : {}) });
  if (options.continuationFixture) {
    const fixture = await startApprovalModelFixture(context, {
      sessionApprovalPrompt: 'CONTINUE_ONCE_FIXTURE', sessionApprovalCount: 1,
      sessionApprovalCommand: 'printf x >> continuation-count.txt',
      sessionApprovalFinalText: 'CONTINUATION_FINISHED',
      httpErrorPrompt: 'CONTINUE_ONCE_FIXTURE', httpErrorAfterToolResults: 1,
      httpErrorMatchLimit: 1, httpErrorStatus: 503,
    });
    const key = randomBytes(16).toString('hex');
    context.registerSecret(key);
    await context.writeStateJson('kcoder-home/credentials.json', { fixture: { type: 'api', key } });
    await context.writeStateJson('kcoder-home/settings.json', {
      credential_store: 'file', active_provider: 'fixture', permission_mode: 'yolo', max_retries: 0,
      providers: { fixture: { api_format: 'openai_chat_completions', endpoint: fixture.baseUrl,
        default_model: 'fixture-model', context_window_tokens: 64000,
        max_output_tokens: 1024, output_headroom_tokens: 1024, no_proxy: true } },
    });
  }
  const gateway = await startGateway(context, {
    label: 'electron-gateway', auth: true, workspace, kcoderBin: options.kcoderBin,
    dropSaveReply: options.dropSaveReply,
    dropSteerReply: options.dropSteerReply,
    delayCancelReply: options.delayCancelReply,
    delayWorkspaceFileReply: options.delayWorkspaceFileReply,
    uiReceiptFault: options.uiReceiptFault,
    env: {
      KCODER_CONFIG_DIR: configDirectory,
      KCODER_STUDIO_WEB_ROOT: options.rendererRoot,
      KCODER_STUDIO_SCENARIO: options.scenario,
    },
  });
  const cookie = await login(gateway.baseUrl, gateway.authToken);
  context.registerSecret(cookie);
  await waitForGatewayRpcToken(context, gateway, { headers: { cookie } });
  const fingerprint = async path => {
    const hash = createHash('sha256');
    for await (const chunk of createReadStream(path)) hash.update(chunk);
    return hash.digest('hex');
  };
  await context.writeArtifactJson('launch-policy.json', {
    gatewayOrigin: gateway.baseUrl,
    nativeIpcPolicy: 'actual Electron thin host; contextIsolation and sandbox; allowlisted preload only',
    capturePolicy: 'owned Electron page capture through its run-local CDP endpoint',
    osSandbox: !options.noSandbox,
    scenario: options.scenario ?? null,
    inputs: {
      electronBinary: { path: options.electronBin, sha256: await fingerprint(options.electronBin) },
      kcoderBinary: { path: options.kcoderBin, sha256: await fingerprint(options.kcoderBin) },
      renderer: { path: options.rendererRoot, indexSha256: await fingerprint(join(options.rendererRoot, 'index.html')) },
    },
  });
  const display = await startOwnedDisplay(context);
  const environment = buildAiVerifyGatewayEnvironment(process.env, {
    sessionDirectory: context.stateDir,
  });
  environment.DISPLAY = display.display;
  environment.XAUTHORITY = display.authority;
  environment.GDK_BACKEND = 'x11';
  await mkdir(environment.HOME, { recursive: true });
  const userData = context.pathInState('electron-profile');
  await mkdir(userData);
  Object.assign(environment, {
    KCODER_STUDIO_REMOTE_URL: gateway.baseUrl,
    KCODER_STUDIO_REMOTE_TOKEN: gateway.authToken,
    KCODER_STUDIO_DESKTOP_USER_DATA_DIR: userData,
  });
  const app = context.spawnOwned('electron-app', options.electronBin, [
    fileURLToPath(new URL('../../desktop/remote-main.mjs', import.meta.url)),
    '--remote-debugging-address=127.0.0.1', '--remote-debugging-port=0', '--disable-gpu',
    ...(options.noSandbox ? ['--no-sandbox', '--disable-setuid-sandbox'] : []),
  ], { cwd: workspace, env: environment });
  const endpoint = await waitFor(async () => {
    if (app.exitCode !== null) throw new Error('Owned Electron exited before CDP was ready');
    const text = await readFile(join(userData, 'DevToolsActivePort'), 'utf8').catch(() => '');
    const [port, path] = text.trim().split('\n');
    return /^[1-9][0-9]{0,4}$/.test(port) && Number(port) <= 65535 && /^\/devtools\/browser\/[A-Za-z0-9-]+$/.test(path || '')
      ? { port: Number(port), url: `ws://127.0.0.1:${port}${path}` } : null;
  }, 30_000, 'owned Electron CDP endpoint', 50, context.abortSignal);
  context.registerPort('electron-cdp', endpoint.port);
  const browser = await chromium.connectOverCDP(endpoint.url, { timeout: 10_000 });
  context.addCleanup('close owned Electron CDP client', () => browser.close());
  const page = await waitFor(() => browser.contexts().flatMap(context => context.pages())
    .find(page => page.url().startsWith(`${gateway.baseUrl}/`)),
    30_000, 'owned Electron Gateway window', 50, context.abortSignal);
  const browserContext = page.context();
  // Do not interrupt the real host's initial loadURL promise with the instrumented reload.
  await page.waitForLoadState('load', { timeout: 30_000 });
  const bootstrap = (await readFile(new URL('./electron-verification-bootstrap.js', import.meta.url), 'utf8'))
    .replace('__KCODER_VERIFY_CONFIG__', JSON.stringify({ origin: gateway.baseUrl, controlUrl, token }));
  await browserContext.addInitScript({ content: bootstrap });
  await page.reload({ waitUntil: 'domcontentloaded', timeout: 30_000 });
  let resizeCommands = 0;
  const runXdotool = async args => {
        const child = context.spawnOwned(`electron-resize-${++resizeCommands}`, '/usr/bin/xdotool', args, { env: environment });
        let output = '', closed = false;
        child.stdout.on('data', bytes => { output += bytes.toString(); });
        child.once('close', () => { closed = true; });
        await waitFor(() => closed, 10_000, 'owned-window resize command', 25);
        if (child.exitCode !== 0) throw new Error('Owned-window resize failed');
        return output.trim();
      };
  return {
    app, gatewayOrigin: gateway.baseUrl,
    resizeWindow: async (selector, value) => {
      if (selector !== 'body') throw new Error('Owned-window resize requires body selector');
      const { width, height } = parseOwnedWindowSize(value);
      if (app.exitCode !== null || display.child.exitCode !== null) throw new Error('Owned Electron display is unavailable');
      const ids = (await runXdotool(['search', '--onlyvisible', '--pid', String(app.pid)])).split(/\s+/).filter(Boolean);
      if (ids.length !== 1 || !/^\d+$/.test(ids[0])) throw new Error('Expected one visible window belonging to this run');
      await runXdotool(['windowsize', '--sync', ids[0], String(width), String(height)]);
      return `${width}x${height}`;
    },
    dragPointer: async (selector, value) => {
      if (selector !== 'body') throw new Error('Owned pointer requires body selector');
      const [x,y,targetX,targetY] = parseOwnedPointerDrag(value);
      if (app.exitCode !== null || display.child.exitCode !== null) throw new Error('Owned Electron display is unavailable');
      const ids = (await runXdotool(['search', '--onlyvisible', '--pid', String(app.pid)])).split(/\s+/).filter(Boolean);
      if (ids.length !== 1 || !/^\d+$/.test(ids[0])) throw new Error('Expected one visible owned window');
      const args = ['mousemove', '--sync', '--window', ids[0], String(x), String(y), 'mousedown', '1'];
      for (let step=1;step<=8;step++) args.push('sleep','0.025','mousemove','--sync','--window',ids[0],String(Math.round(x+(targetX-x)*step/8)),String(Math.round(y+(targetY-y)*step/8)));
      args.push('mouseup','1');
      try { await runXdotool(args); }
      finally { await runXdotool(['mouseup','1']); }
      return 'dragged';
    },
    capture: async selector => {
      if (selector !== 'body') throw new Error('Owned-display capture requires --selector body');
      if (app.exitCode !== null || display.child.exitCode !== null) throw new Error('Owned Electron display is unavailable');
      const png = await page.screenshot({ type: 'png', timeout: 10_000 });
      return `data:image/png;base64,${png.toString('base64')}`;
    },
  };
}
