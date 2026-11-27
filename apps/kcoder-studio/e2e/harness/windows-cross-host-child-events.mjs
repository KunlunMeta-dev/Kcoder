import childProcess from 'node:child_process';
import { appendFileSync } from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { observeCrossHostNativeErrors } from './windows-cross-host-rpc-observation.mjs';
const destination = process.env.KCODER_E2E_CHILD_EVENTS;
const original = childProcess.spawn;
childProcess.spawn = function (...args) {
  const child = original(...args);
  const write = (event, extra = {}) => appendFileSync(destination, JSON.stringify({
    at: Date.now(), pid: child.pid ?? null, event, exitCode: child.exitCode, signalCode: child.signalCode,
    stdoutDestroyed: child.stdout?.destroyed ?? null, stderrDestroyed: child.stderr?.destroyed ?? null,
    ...extra,
  }) + '\n');
  write('spawn');
  const kill = child.kill.bind(child);
  child.kill = signal => { const result = kill(signal); write('kill', { signal, result }); return result; };
  child.on('exit', (code, signal) => write('exit', { code, signal }));
  child.on('close', (code, signal) => write('close', { code, signal }));
  child.on('error', error => write('error', { code: error.code ?? null }));
  child.stdin?.on('finish', () => write('stdin-finish'));
  let pending = '';
  child.stdout?.on('data', data => {
    pending += data.toString('utf8');
    if (pending.length > 2 * 1024 * 1024) { pending = ''; return; }
    const lines = pending.split('\n'); pending = lines.pop();
    for (const line of lines) {
      try {
        const response = JSON.parse(line), reason = /\bsource_transfer_[a-z_]+\b/.exec(response.error?.message ?? '')?.[0];
        if (reason) write('native-error', { code: response.error.code, reason });
      } catch { /* Diagnostics never alter protocol framing or log unknown content. */ }
    }
  });
  for (const [name, stream] of [['stdout', child.stdout], ['stderr', child.stderr]]) {
    stream?.on('end', () => write(name + '-end')); stream?.on('close', () => write(name + '-close'));
  }
  return child;
};
syncBuiltinESMExports();
// Import the exact copied Gateway module; production files and dispatch order are unchanged.
const { WorkspaceAppServerBroker } = await import(pathToFileURL(join(dirname(process.argv[1]), 'src/workspace-app-server-broker.js')).href);
observeCrossHostNativeErrors(WorkspaceAppServerBroker, record => appendFileSync(destination,
  JSON.stringify({ event: 'native-rpc-error', at: Date.now(), ...record }) + '\n'));
