import { randomBytes } from 'node:crypto';
import { lstat, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { appRoot, repoRoot, waitFor } from './run-context.mjs';
import { createGatewayVerificationRun, gatewayVerificationOptions } from './ai-verify-gateway.mjs';
import { finishUnpublishedGatewaySession } from '../../renderer/scripts/ai-verify.mjs';
import { validateAiVerifyGatewayOrigin } from '../../renderer/scripts/ai-verify-environment.mjs';

async function readSession(path) {
  try { return JSON.parse(await readFile(path, 'utf8')); }
  catch (error) { if (error instanceof SyntaxError) return null; throw error; }
}

export function assertOwnedControllerRequest(child, stopping, path) {
  if (child.exitCode !== null || child.signalCode !== null) throw new Error('Owned Electron controller is closed');
  if (stopping && path !== '/shutdown') throw new Error('Owned Electron controller is stopping');
}

/** Settle the original controller and its receipts without inventing nested-run cleanup. */
export async function stopOwnedAiVerifyController({
  run, sessionPath, child, requestShutdown, stopController, initialSession,
  readSessionFile = () => readSession(sessionPath),
  readResultFile = async () => JSON.parse(await readFile(join(run.artifactsDir, 'result.json'), 'utf8')),
  stateExists = async () => {
    try { await lstat(run.stateDir); return true; }
    catch (error) { if (error.code === 'ENOENT') return false; throw error; }
  },
  finalizeUnpublished = finishUnpublishedGatewaySession, poll = waitFor,
}) {
  const failures = [];
  let session, terminal, shutdownUnconfirmed = false, ownerStop;
  const stopOwner = () => ownerStop ??= Promise.resolve().then(stopController);
  const ownerClosed = () => child.exitCode !== null || child.signalCode !== null;
  try {
    try { session = await poll(readSessionFile, 5_000, 'verification session state'); }
    catch (error) { failures.push(error); }
    if (session?.status !== 'stopped' && session?.controlUrl) {
      try { await requestShutdown(); }
      catch { shutdownUnconfirmed = true; }
    }
    if (shutdownUnconfirmed || session && !session.controlUrl && session.status !== 'stopped' || !session) {
      try { await stopOwner(); }
      catch (error) { failures.push(error); }
      if (session && !session.controlUrl && ownerClosed()) {
        const current = await readSessionFile().catch(error => { failures.push(error); return null; });
        // Only an unchanged pre-launch document can authorize the unpublished fallback.
        // A truncated or incomplete document cannot revoke the nested owner's authority.
        if (initialSession?.version === 1 && initialSession.directory === run.runRoot &&
            initialSession.status === 'starting' && !Object.hasOwn(initialSession, 'controlUrl') &&
            isDeepStrictEqual(current, initialSession)) {
          const failure = new Error('Verification controller stopped before publication');
          try { await finalizeUnpublished(run, sessionPath, failure); }
          catch (error) { if (error !== failure) failures.push(error); }
        } else if (current?.status !== 'stopped') {
          failures.push(new Error('Unpublished controller session identity is unconfirmed; preserve the original run and authority receipts'));
        }
      }
    }
    try {
      terminal = await poll(async () => {
        const current = await readSessionFile();
        if (current?.status === 'stopped') return current;
        if (ownerClosed()) throw new Error('Published controller cleanup is unconfirmed; preserve the original run and authority receipts');
        return null;
      }, 30_000, 'owned Electron cleanup');
    } catch (error) { failures.push(error); }
  } finally {
    try { await stopOwner(); }
    catch (error) { if (!failures.includes(error)) failures.push(error); }
  }
  // A lost shutdown reply is reconciled only against the authoritative terminal receipt.
  const current = await readSessionFile().catch(error => { failures.push(error); return null; });
  terminal = current?.status === 'stopped' ? current : terminal;
  if (!terminal) failures.push(new Error('Original nested verification cleanup remains unknown; retain its recorded run'));
  if (terminal?.cleanupError) failures.push(new Error(terminal.cleanupError));
  if (terminal) {
    try {
      const result = await readResultFile();
      if (!['passed', 'failed'].includes(result?.status) || !Array.isArray(result.cleanupErrors)) {
        throw new Error('Original nested verification cleanup receipt is invalid');
      }
      if (result.cleanupErrors.length) throw new Error('Owned Electron cleanup reported errors');
      if (await stateExists()) throw new Error('Owned Electron state survived cleanup');
    } catch (error) { failures.push(error); }
  }
  if (failures.length) throw new AggregateError(failures, 'Owned Electron controller cleanup was not confirmed');
  return { runRoot: run.runRoot, verificationFailed: Boolean(terminal.verificationError), cleaned: true,
    shutdownRequestUnconfirmed: shutdownUnconfirmed };
}

export async function startOwnedAiVerify(context, options) {
  if (options.timezone) new Intl.DateTimeFormat('en', { timeZone: options.timezone }).format(0);
  const gateway = await gatewayVerificationOptions({
    'electron-bin': options.electronBin, 'kcoder-bin': options.kcoderBin, 'renderer-root': options.rendererRoot,
    ...(options.delayCancelReply ? { 'delay-cancel-reply': 'true' } : {}),
    ...(options.delayWorkspaceFileReply ? { 'delay-workspace-file-reply': 'true' } : {}),
    ...(options.uiReceiptFault ? { 'ui-receipt-fault': 'true' } : {}),
    ...(options.dropSaveReply ? { 'drop-save-reply': 'true' } : {}),
    ...(options.dropSteerReply ? { 'drop-steer-reply': 'true' } : {}),
  });
  const run = await createGatewayVerificationRun();
  const token = randomBytes(32).toString('hex');
  context.registerSecret(token);
  const sessionPath = join(run.runRoot, 'session.json');
  let handedOff = false;
  context.addCleanup('finalize unpublished Electron run', async () => {
    if (handedOff) return;
    const failure = new Error('Verification controller was not launched');
    await finishUnpublishedGatewaySession(run, sessionPath, failure).catch(error => { if (error !== failure) throw error; });
  });
  const sessionDocument = JSON.stringify({ version: 1, directory: run.runRoot, gateway, token, status: 'starting' });
  const initialSession = JSON.parse(sessionDocument);
  await writeFile(sessionPath, sessionDocument, { mode: 0o600 });
  const child = context.spawnOwned('electron-controller', process.execPath, [
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
  const stop = () => stopPromise ??= stopOwnedAiVerifyController({
    run, sessionPath, child, initialSession,
    requestShutdown: () => request('/shutdown', startupFailed ? { failure: 'startup-timeout' }
      : failed || context.abortReason ? { failure: 'verification-failed' } : {}),
    stopController: () => context.stopOwned('electron-controller'),
  });
  // Register before readiness: an aborted or failed startup still owns its controller.
  context.addCleanup('stop owned Electron verification', stop, { timeoutMs: 120_000 });
  handedOff = true;
  await context.writeArtifactJson('electron-run.json', { runRoot: run.runRoot });
  try { await waitFor(async () => {
    activeSession = await readSession(sessionPath);
    if (activeSession?.status === 'stopped') throw new Error(activeSession.startupError || activeSession.verificationError || 'Electron stopped before readiness');
    if (child.exitCode !== null) throw new Error('Electron controller exited before readiness');
    if (!activeSession?.controlUrl) return null;
    const status = await request('/status');
    return status.ready ? status : null;
  }, options.timeoutMs || 45_000, 'real Electron Gateway readiness', 100, context.abortSignal); }
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
      if (typeof result.value !== 'string' || !result.value.startsWith(prefix)) throw new Error('Invalid Electron capture');
      const output = context.pathInArtifacts(name);
      await writeFile(output, Buffer.from(result.value.slice(prefix.length), 'base64'), { mode: 0o600 });
      return output;
    },
  };
}
