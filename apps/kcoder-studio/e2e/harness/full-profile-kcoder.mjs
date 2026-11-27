#!/usr/bin/env node
// Explicit full-tool-profile entry for Gateway-owned piped app-server fixtures.
// All protocol I/O belongs to the real CLI; this launcher never fabricates frames.
import { spawn } from 'node:child_process';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export function startPipedFullProfile({
  stdin = process.stdin, stdout = process.stdout, owner = process, spawnProcess = spawn,
  binary = process.env.KCODER_E2E_KCODER_BIN || fileURLToPath(new URL('../../../../target/debug/kcoder', import.meta.url)),
  args = process.argv.slice(2),
} = {}) {
  if (stdin.isTTY || stdout.isTTY) throw new Error('UNMET_PREREQUISITE: full-profile fixture requires piped app-server stdio');
  const child = spawnProcess(binary, ['--tool-profile', 'full', ...args], { stdio: 'inherit' });
  const handlers = new Map();
  for (const signal of ['SIGTERM', 'SIGINT']) {
    const handler = () => child.kill(signal);
    handlers.set(signal, handler); owner.on(signal, handler);
  }
  child.once('error', () => { owner.stderr.write('Owned full-profile CLI failed to start\n'); owner.exitCode = 1; });
  child.once('exit', code => { owner.exitCode = code ?? 1; });
  child.once('close', () => { for (const [signal, handler] of handlers) owner.removeListener(signal, handler); });
  return child;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { startPipedFullProfile(); }
  catch (error) {
    process.stderr.write(error?.message === 'UNMET_PREREQUISITE: full-profile fixture requires piped app-server stdio'
      ? `${error.message}\n` : 'Owned full-profile CLI failed to start\n');
    process.exitCode = 1;
  }
}
