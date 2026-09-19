import { constants, createReadStream } from 'node:fs';
import { access, mkdir, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { createHash, randomBytes } from 'node:crypto';
import { basename, dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { RunContext, repoRoot, waitFor } from './run-context.mjs';
import { startGateway, waitForGatewayRpcToken } from './gateway.mjs';
import { materializeWorkspace } from './workspace-fixture.mjs';
import { buildAiVerifyGatewayEnvironment } from '../../renderer/scripts/ai-verify-environment.mjs';

const metadata = {
  testId: 'ai-verify-owned-tauri-gateway',
  modelPolicy: 'model-independent',
  retainSuccessEvidence: true,
  evidenceReason: 'Explicit real Tauri verification with an owned display',
};

export async function gatewayVerificationOptions(options) {
  if (process.platform !== 'linux') throw new Error('Owned-display Gateway verification currently requires Linux');
  const allowed = new Set(['gateway', 'tauri-bin', 'kcoder-bin', 'renderer-root', 'timeout']);
  if (Object.keys(options).some(name => !allowed.has(name))) {
    throw new Error('Unknown Gateway verification option; external origins, tokens and displays are not accepted');
  }
  for (const name of ['tauri-bin', 'kcoder-bin', 'renderer-root']) {
    if (!options[name]) throw new Error(`Gateway verification requires --${name}`);
  }
  const tauriBin = await realpath(resolve(options['tauri-bin']));
  const kcoderBin = await realpath(resolve(options['kcoder-bin']));
  const rendererRoot = await realpath(resolve(options['renderer-root']));
  await Promise.all([
    access(tauriBin, constants.X_OK), access(kcoderBin, constants.X_OK),
    access(join(rendererRoot, 'index.html'), constants.R_OK),
    access('/usr/bin/Xvfb', constants.X_OK), access('/usr/bin/import', constants.X_OK),
    access('/usr/bin/git', constants.X_OK),
  ]);
  return { tauriBin, kcoderBin, rendererRoot };
}

export async function createGatewayVerificationRun() {
  return RunContext.create(import.meta.url, metadata);
}

export async function resumeGatewayVerificationRun(runRoot, token) {
  const source = fileURLToPath(import.meta.url);
  const sourceRelative = relative(repoRoot, source);
  const canonicalRoot = await realpath(runRoot);
  const expectedParent = resolve(repoRoot, 'target/test', sourceRelative);
  if (dirname(canonicalRoot) !== expectedParent || !/^\d{8}-\d{6}\.\d{3}Z(?:-p\d+-\d+-[a-f0-9]+)?$/.test(basename(canonicalRoot))) {
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

export async function startOwnedDisplay(context) {
  const cookie = randomBytes(16);
  context.registerSecret(cookie.toString('hex'));
  const authority = context.pathInState('display.xauthority');
  await writeFile(authority, xauthorityRecord('0', cookie), { mode: 0o600, flag: 'wx' });
  const child = context.spawnOwned('tauri-display', '/usr/bin/Xvfb', [
    '-displayfd', '1', '-screen', '0', '1280x900x24', '-nolisten', 'tcp', '-auth', authority,
  ]);
  let output = '';
  child.stdout.on('data', chunk => { output += chunk.toString(); });
  const number = await waitFor(() => {
    if (child.exitCode !== null) throw new Error('Owned Xvfb exited before allocating a display');
    return output.match(/^(\d+)\r?$/m)?.[1];
  }, 10_000, 'owned Xvfb display', 50);
  await writeFile(authority, xauthorityRecord(number, cookie), { mode: 0o600 });
  return { display: `:${number}`, authority, child };
}

export async function prepareGatewayWorkspace(context) {
  const { path: workspace } = await materializeWorkspace(context, 'rust-project', {
    instanceId: 'tauri-verification',
  });
  const child = context.spawnOwned('tauri-workspace-git', '/usr/bin/git', [
    '-c', 'init.templateDir=', 'init', '--initial-branch=main', workspace,
  ], { env: context.isolatedEnvironment({ GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null' }) });
  await waitFor(() => child.exitCode !== null, 10_000, 'owned workspace Git boundary');
  if (child.exitCode !== 0) throw new Error('Failed to create owned workspace Git boundary');
  return workspace;
}

export async function launchGatewayVerification(context, options, { controlUrl, token }) {
  const workspace = await prepareGatewayWorkspace(context);
  const configDirectory = context.pathInState('kcoder-home');
  await mkdir(configDirectory);
  // An empty explicit model catalogue prevents accidental default-provider network calls.
  await context.writeStateJson('kcoder-home/settings.json', { providers: {} });
  const gateway = await startGateway(context, {
    label: 'tauri-gateway', workspace, kcoderBin: options.kcoderBin,
    env: {
      KCODER_CONFIG_DIR: configDirectory,
      KCODER_STUDIO_WEB_ROOT: options.rendererRoot,
    },
  });
  await waitForGatewayRpcToken(context, gateway);
  const fingerprint = async path => {
    const hash = createHash('sha256');
    for await (const chunk of createReadStream(path)) hash.update(chunk);
    return hash.digest('hex');
  };
  await context.writeArtifactJson('launch-policy.json', {
    gatewayOrigin: gateway.baseUrl,
    nativeIpcPolicy: 'deny-all; external WebView URL; unchanged default devUrl and capabilities',
    capturePolicy: 'authenticated owned Xvfb only',
    inputs: {
      tauriBinary: { path: options.tauriBin, sha256: await fingerprint(options.tauriBin) },
      kcoderBinary: { path: options.kcoderBin, sha256: await fingerprint(options.kcoderBin) },
      renderer: { path: options.rendererRoot, indexSha256: await fingerprint(join(options.rendererRoot, 'index.html')) },
    },
  });
  const display = await startOwnedDisplay(context);
  const environment = buildAiVerifyGatewayEnvironment(process.env, {
    gatewayOrigin: gateway.baseUrl, controlUrl, token, sessionDirectory: context.stateDir,
  });
  environment.DISPLAY = display.display;
  environment.XAUTHORITY = display.authority;
  environment.GDK_BACKEND = 'x11';
  await Promise.all([
    mkdir(environment.HOME, { recursive: true }),
    mkdir(environment.KCODER_STUDIO_APP_CONFIG_DIR, { recursive: true }),
  ]);
  const app = context.spawnOwned('tauri-app', options.tauriBin, [], {
    cwd: workspace, env: environment,
  });
  let captures = 0;
  return {
    app, gatewayOrigin: gateway.baseUrl,
    capture: async selector => {
      if (selector !== 'body') throw new Error('Owned-display capture requires --selector body');
      if (app.exitCode !== null || display.child.exitCode !== null) throw new Error('Owned Tauri display is unavailable');
      const label = `tauri-capture-${++captures}`;
      const output = context.pathInState(`${label}.png`);
      const capture = context.spawnOwned(label, '/usr/bin/import', [
        '-display', display.display, '-window', 'root', output,
      ], { env: environment });
      await waitFor(() => capture.exitCode !== null, 10_000, 'owned-display capture', 25);
      if (capture.exitCode !== 0) throw new Error('Owned-display capture failed');
      const png = await readFile(output);
      await rm(output);
      if (png.subarray(0, 8).toString('hex') !== '89504e470d0a1a0a') throw new Error('Invalid owned-display PNG');
      return `data:image/png;base64,${png.toString('base64')}`;
    },
  };
}
