import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { repoRoot, waitFor } from './run-context.mjs';

export function tuiRunFromOwnedLog(log, root = repoRoot) {
  const boundary = resolve(root, 'target/tui-lab') + sep;
  const run = log.split('\n').map(line => line.trim()).filter(line => line.startsWith(boundary)).at(-1);
  if (!run) return null;
  const actual = resolve(run);
  assert.ok(actual.startsWith(boundary), 'The owned TUI run must remain inside its artifact root');
  return actual;
}

/** A single parent RunContext owns the existing TUI Lab command and its evidence. */
export async function runOwnedTuiLab(context, { binary, binarySha256, scenario, description, label = 'actual-peer-tui', timeoutMs = 90000 }) {
  assert.match(scenario, /^[a-z0-9-]+$/); assert.match(description, /^[a-z0-9-]+$/);
  const child = context.spawnOwned(label, process.execPath,
    [resolve(repoRoot, 'tools/tui-lab/bin/tui-lab.mjs'), 'tool-liveness', '--scenario', scenario,
      '--software-webgl', '--description', description, '--timeout-ms', String(timeoutMs)], {
      cwd: repoRoot, env: context.isolatedEnvironment({ KCODER_E2E_KCODER_BIN: binary,
        KCODER_E2E_KCODER_BIN_SHA256: binarySha256,
        KCODER_TUI_LAB_CONFIG_ROOT: process.env.KCODER_TUI_LAB_CONFIG_ROOT || join(homedir(), '.kcoder-tui-lab'),
        KCODER_TUI_LAB_CONFIG_TRUST_ROOT: process.env.KCODER_TUI_LAB_CONFIG_TRUST_ROOT || homedir(),
      }, ['KCODER_E2E_RENDERER_ROOT', 'KCODER_E2E_CHROMIUM_BIN', 'KCODER_E2E_CHROMIUM_NO_SANDBOX', 'KCODER_E2E_REQUIRE_CHROMIUM_SANDBOX']),
    });
  await waitFor(() => child.exitCode !== null || child.signalCode !== null, timeoutMs + 90000,
    'owned actual PTY/xterm scenario', 100, context.abortSignal);
  const log = await readFile(join(context.logsDir, `${label}.log`), 'utf8');
  const runRoot = tuiRunFromOwnedLog(log);
  if (runRoot) await context.writeArtifactJson('owned-tui-run.json', { runRoot, binarySha256, exitCode: child.exitCode });
  assert.equal(child.exitCode, 0, 'Inspect this run and the retained owned TUI failure evidence');
  assert.ok(runRoot, 'The original TUI Lab must publish its owned run');
  const evidence = JSON.parse(await readFile(join(runRoot, 'assertions.json'), 'utf8'));
  assert.equal(evidence.ok, true);
  return { evidence, runRoot };
}
