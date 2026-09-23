import { randomBytes } from 'node:crypto';
import { access, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { appRoot, repoRoot, waitFor } from './run-context.mjs';
import { createGatewayVerificationRun, gatewayVerificationOptions } from './ai-verify-gateway.mjs';
import { finishUnpublishedGatewaySession } from '../../renderer/scripts/ai-verify.mjs';
import { validateAiVerifyGatewayOrigin } from '../../renderer/scripts/ai-verify-environment.mjs';

async function readSession(path) {
  try { return JSON.parse(await readFile(path, 'utf8')); }
  catch (error) { if (error instanceof SyntaxError) return null; throw error; }
}

export function assertOwnedControllerRequest(child, stopping, path) {
  if (child.exitCode !== null || child.signalCode !== null) throw new Error('Owned Tauri controller is closed');
  if (stopping && path !== '/shutdown') throw new Error('Owned Tauri controller is stopping');
}

export async function startOwnedAiVerify(context, options) {
  if (options.timezone) new Intl.DateTimeFormat('en', { timeZone: options.timezone }).format(0);
  const gateway = await gatewayVerificationOptions({
    'tauri-bin': options.tauriBin, 'kcoder-bin': options.kcoderBin, 'renderer-root': options.rendererRoot,
    ...(options.delayCancelReply ? { 'delay-cancel-reply': 'true' } : {}),
    ...(options.dropSaveReply ? { 'drop-save-reply': 'true' } : {}),
  });
  const run = await createGatewayVerificationRun();
  const token = randomBytes(32).toString('hex');
  context.registerSecret(token);
  const sessionPath = join(run.runRoot, 'session.json');
  let handedOff = false;
  context.addCleanup('finalize unpublished Tauri run', async () => {
    if (handedOff) return;
    const failure = new Error('Verification controller was not launched');
    await finishUnpublishedGatewaySession(run, sessionPath, failure).catch(error => { if (error !== failure) throw error; });
  });
  await writeFile(sessionPath, JSON.stringify({ version: 1, directory: run.runRoot, gateway, token, status: 'starting' }), { mode: 0o600 });
  const child = context.spawnOwned('tauri-controller', process.execPath, [
    resolve(appRoot, 'renderer/scripts/ai-verify.mjs'), 'serve', '--session', sessionPath,
  ], { cwd: repoRoot, env: context.isolatedEnvironment(options.timezone ? { TZ: options.timezone } : {}) });
  let activeSession = null;
  let failed = false;
  let startupFailed = false;
  let stopPromise = null;
  const request = async (path, body) => {
    assertOwnedControllerRequest(child, Boolean(stopPromise), path);
    const origin = validateAiVerifyGatewayOrigin(activeSession.controlUrl);
    const timeout = AbortSignal.timeout(path === '/status' ? 3_000 : (body?.timeoutMs || 30_000) + 10_000);
    const response = await fetch(`${origin}${path}`, {
      method: body === undefined ? 'GET' : 'POST', redirect: 'error',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: path === '/shutdown' || !context.abortSignal ? timeout : AbortSignal.any([timeout, context.abortSignal]),
    });
    const result = await response.json();
    if (!response.ok || result.ok === false) throw new Error(result.error || `Verification control failed: ${response.status}`);
    return result;
  };
  const stop = () => stopPromise ??= (async () => {
    activeSession = await waitFor(() => readSession(sessionPath), 5_000, 'verification session state');
    if (activeSession.status !== 'stopped') {
      if (activeSession.controlUrl) {
        await request('/shutdown', startupFailed ? { failure: 'startup-timeout' } : failed || context.abortReason ? { failure: 'verification-failed' } : {});
      } else {
        await context.stopOwned('tauri-controller');
        activeSession = await readSession(sessionPath);
        if (activeSession?.status !== 'stopped' && !activeSession?.controlUrl) {
          await finishUnpublishedGatewaySession(run, sessionPath, new Error('Verification controller stopped before publication')).catch(() => {});
        }
      }
    }
    const stopped = await waitFor(async () => {
      const current = await readSession(sessionPath);
      return current?.status === 'stopped' ? current : null;
    }, 30_000, 'owned Tauri cleanup');
    await context.stopOwned('tauri-controller');
    if (stopped.cleanupError) throw new Error(stopped.cleanupError);
    const result = JSON.parse(await readFile(join(run.artifactsDir, 'result.json'), 'utf8'));
    if (result.cleanupErrors?.length) throw new Error('Owned Tauri cleanup reported errors');
    if (await access(run.stateDir).then(() => true, () => false)) throw new Error('Owned Tauri state survived cleanup');
    return { runRoot: run.runRoot, verificationFailed: Boolean(stopped.verificationError), cleaned: true };
  })();
  // Register before readiness: an aborted or failed startup still owns its controller.
  context.addCleanup('stop owned Tauri verification', stop);
  handedOff = true;
  await context.writeArtifactJson('tauri-run.json', { runRoot: run.runRoot });
  try { await waitFor(async () => {
    activeSession = await readSession(sessionPath);
    if (activeSession?.status === 'stopped') throw new Error(activeSession.startupError || activeSession.verificationError || 'Tauri stopped before readiness');
    if (child.exitCode !== null) throw new Error('Tauri controller exited before readiness');
    if (!activeSession?.controlUrl) return null;
    const status = await request('/status');
    return status.ready ? status : null;
  }, options.timeoutMs || 45_000, 'real Tauri Gateway readiness', 100, context.abortSignal); }
  catch (error) { startupFailed = true; throw error; }
  return {
    runRoot: run.runRoot,
    settingsPath: join(run.stateDir, 'kcoder-home', 'settings.json'),
    markFailed: () => { failed = true; },
    stop,
    command: async (action, args = {}) => (await request('/command', { action, selector: 'body', ...args })).value,
    capture: async name => {
      const result = await request('/command', { action: 'capture', selector: 'body' });
      const prefix = 'data:image/png;base64,';
      if (typeof result.value !== 'string' || !result.value.startsWith(prefix)) throw new Error('Invalid Tauri capture');
      const output = context.pathInArtifacts(name);
      await writeFile(output, Buffer.from(result.value.slice(prefix.length), 'base64'), { mode: 0o600 });
      return output;
    },
  };
}
