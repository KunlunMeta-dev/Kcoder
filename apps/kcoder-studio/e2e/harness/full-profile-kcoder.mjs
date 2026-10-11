#!/usr/bin/env node
// Explicit full-tool-profile entry for model-independent skill/extension fixtures.
// All protocol I/O belongs to the real CLI; this launcher never fabricates frames.
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
const binary = process.env.KCODER_E2E_KCODER_BIN || fileURLToPath(new URL('../../../../target/debug/kcoder', import.meta.url));
const child = spawn(binary, ['--tool-profile', 'full', ...process.argv.slice(2)], { stdio: 'inherit' });
for (const signal of ['SIGTERM', 'SIGINT']) process.on(signal, () => child.kill(signal));
child.once('error', () => { process.stderr.write('Owned full-profile CLI failed to start\n'); process.exitCode = 1; });
child.once('exit', code => { process.exitCode = code ?? 1; });
