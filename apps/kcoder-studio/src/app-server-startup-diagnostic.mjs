import { nativeStartupDiagnostic, nativeStartupErrorMessage } from '../shared/nativeStartupDiagnostic.mjs';
import { isNativeStartupDiagnosticV1 } from '../shared/generated/contractGuards.core.mjs';
import schemas from '../shared/generated/schemas.json' with { type: 'json' };
export const NATIVE_STARTUP_DIAGNOSTIC_PREFIX = schemas.NativeStartupDiagnosticV1['x-stderr-prefix'];

/** Capture only selected launch facts. In particular, do not copy args or env. */
export function appServerLaunchContext(target, { commandSource = 'unknown', args = [] } = {}) {
  const profileIndex = Array.isArray(args) ? args.indexOf('--profile') : -1;
  const selectedProfile = profileIndex >= 0 && typeof args[profileIndex + 1] === 'string' && /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(args[profileIndex + 1])
    ? args[profileIndex + 1] : target.profile;
  return nativeStartupDiagnostic({ version: 1, code: 'native_startup_failed', phase: 'launch', launch: {
    transport: target.transport, commandSource, command: target.command,
    settingsSource: target.settingsFile ? 'explicit_overlay' : 'target_default',
    ...(target.settingsFile ? { settingsFile: target.settingsFile } : {}),
    ...(selectedProfile ? { profile: selectedProfile } : {}),
  } })?.launch;
}

export function createAppServerStartupDiagnostic({ launch } = {}) {
  let buffered = '', discarding = false, recognized;
  return {
    write(chunk) {
      // A raw line is transient parser input only. Unknown/oversized lines are
      // discarded, never forwarded to logs, browser errors or saved diagnostics.
      for (const part of String(chunk).split(/(?<=\n)/u)) {
        if (!discarding) buffered += part;
        if (Buffer.byteLength(buffered) > 4096) { buffered = ''; discarding = true; }
        if (!part.endsWith('\n')) continue;
        if (!discarding && buffered.startsWith(NATIVE_STARTUP_DIAGNOSTIC_PREFIX)) {
          try {
            const value = JSON.parse(buffered.slice(NATIVE_STARTUP_DIAGNOSTIC_PREFIX.length));
            if (isNativeStartupDiagnosticV1(value)) {
              const diagnostic = nativeStartupDiagnostic(value);
              if (diagnostic) recognized = diagnostic;
            }
          } catch { /* No raw parse detail crosses the process boundary. */ }
        }
        buffered = ''; discarding = false;
      }
    },
    failure({ error, code, signal, initializing = true } = {}) {
      const spawnCode = error?.code === 'ENOENT' ? 'launcher_unavailable' :
        ['EACCES', 'EPERM'].includes(error?.code) ? 'launcher_access_denied' : undefined;
      return nativeStartupDiagnostic({ version: 1, code: spawnCode ?? recognized?.code ?? 'native_startup_failed',
        phase: recognized?.phase ?? (initializing ? 'initialize' : 'launch'), exitCode: code, signal, launch });
    },
  };
}

export function closeWorkspaceAppServerBroker(broker, code, signal, finishLifecycle) {
  if (broker.closed) return;
  const diagnostic = broker.initializeResponse?.result ? null : broker.startupDiagnostic.failure({ code, signal });
  broker.closed = true;
  broker.resolveShareability?.('closed');
  const disconnected = { jsonrpc: '2.0', method: 'server/disconnected',
    params: { serverId: broker.serverId, code, signal,
      ...(diagnostic ? { startupDiagnostic: diagnostic, message: nativeStartupErrorMessage(diagnostic.code) } : {}) } };
  for (const client of broker.clients) {
    if (client === broker.restartRequest?.client) continue;
    client.send(disconnected); client.close();
  }
  broker.clients.clear(); broker.clearTransientState(); broker.onClose?.(broker); finishLifecycle();
}

/** Existing lifecycle counters only; no command, body or credentials enter logs. */
export function brokerLifecycleReporter(transport, getBrokers) {
  return metrics => {
    let brokerCount = 0;
    for (const brokers of getBrokers().values()) brokerCount += brokers.size;
    process.stderr.write(`${JSON.stringify({ event: 'broker-lifecycle', transport: transport === 'ssh' ? 'ssh' : 'local', brokerCount, ...metrics })}\n`);
  };
}
