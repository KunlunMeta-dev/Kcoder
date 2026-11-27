#!/usr/bin/env node
import { writeFileSync } from 'node:fs';

const ENTRY = '--internal-storage-operation-v1';
const args = process.argv.slice(2);
const mode = process.env.KCODER_STORAGE_TEST_MODE;
const pidFile = process.env.KCODER_STORAGE_TEST_PID_FILE;
const exitFile = process.env.KCODER_STORAGE_TEST_EXIT_FILE;
const handoffFile = process.env.KCODER_STORAGE_TEST_HANDOFF_FILE;

if (pidFile) writeFileSync(pidFile, String(process.pid));
if (process.env.KCODER_STORAGE_TEST_OWNER_RUNTIME_FILE) {
  writeFileSync(process.env.KCODER_STORAGE_TEST_OWNER_RUNTIME_FILE,
    process.env.KCODER_STORAGE_OWNER_RUNTIME_V1 ?? 'absent');
}
if (process.env.KCODER_STORAGE_TEST_RELAUNCH_FILE) {
  writeFileSync(process.env.KCODER_STORAGE_TEST_RELAUNCH_FILE,
    process.env.KCODER_STORAGE_DESKTOP_RELAUNCH_V1 ?? 'absent');
}

async function readInput() {
  let text = '';
  for await (const chunk of process.stdin) text += chunk.toString('utf8');
  return text ? JSON.parse(text) : null;
}

function finish() {
  if (exitFile) writeFileSync(exitFile, 'exited');
  process.exit(0);
}

if (args[0] === 'config' && args[1] === 'storage-paths') {
  process.stdout.write(JSON.stringify({ layout: 'unified', cacheRoot: process.env.HOME }));
} else if (args[0] === ENTRY && args[1] === 'status') {
  process.stdout.write(args[2] ? JSON.stringify({ plan: { operationId: args[2] } }) : 'null');
} else if (args[0] === ENTRY && args[1] === 'cleanup-preview') {
  process.stdout.write(JSON.stringify({ operationId: args[2], confirmation: 'c'.repeat(64), pending: false, entries: [] }));
} else if (args[0] === ENTRY && args[1] === 'cleanup-confirm') {
  const request = await readInput();
  process.stdout.write(JSON.stringify({ operationId: args[2], confirmation: request.confirmation, entries: [] }));
} else if (args[0] === ENTRY && args[1] === 'startup') {
  if (mode === 'startup-busy') {
    process.stderr.write('Error: STORAGE_MIGRATION_BUSY\n\nCaused by:\n    private path and lock diagnostic\n');
    process.exitCode = 1;
  } else process.stdout.write(JSON.stringify({ phase: 'verified', disposition: 'complete', operationId: 'legacy-locations-v1' }));
} else if (args[0] === ENTRY && args[1] === 'initialize') {
  process.stdout.write(JSON.stringify({ version: 1, revision: 1, ...await readInput() }));
} else if (args[0] === ENTRY && args[1] === 'execute') {
  const plan = await readInput();
  process.stdout.write(JSON.stringify({ phase: 'verified', disposition: 'complete', plan }), finish);
} else if (args[0] === ENTRY && args[1] === 'plan') {
  if (mode === 'plan-reference-cause') {
    process.stderr.write('Error: managed_worktree_profile_registry_invalid\n\nCaused by:\n    0: private worker context\n    1: STORAGE_MANAGED_WORKTREE_INTERNAL_ALIAS_UNSUPPORTED\n');
    process.exit(1);
  }
  const code = mode === 'plan-native-code-unsupported'
    ? 'SERVICE_LEASE_NATIVE_CODE_RELOCATION_UNSUPPORTED'
    : mode === 'plan-legacy-host-unsupported'
      ? 'SERVICE_LEASE_LEGACY_HOST_RELOCATION_UNSUPPORTED'
      : mode.startsWith('plan-reference:') ? mode.slice('plan-reference:'.length) : null;
  if (code) {
    process.stderr.write(`Error: ${code}\n`);
    process.exitCode = 1;
  } else if (mode === 'plan-untrusted-stderr') {
    process.stderr.write('Error: SERVICE_LEASE_NATIVE_CODE_RELOCATION_UNSUPPORTED at /private/user/data\n');
    process.exitCode = 1;
  } else if (mode?.startsWith('plan-credential:')) {
    process.stderr.write(`Error: ${mode.slice('plan-credential:'.length)}\n`);
    process.exitCode = 1;
  } else process.stdout.write(JSON.stringify(await readInput()));
} else if (args[0] === ENTRY && ['handoff', 'retry-handoff'].includes(args[1])) {
  const plan = await readInput();
  if (handoffFile) writeFileSync(handoffFile, JSON.stringify({ mode: args[1], plan }));
  if (mode === 'not-ready') {
    setInterval(() => {}, 1000);
    await new Promise(() => {});
  }
  if (mode === 'early-exit') finish();
  if (mode === 'malformed') process.stdout.write('not-json\n');
  else if (mode === 'oversized-stdout') process.stdout.write('x'.repeat(1024 * 1024 + 1));
  else if (mode === 'oversized-stderr') process.stderr.write('x'.repeat(1024 * 1024 + 1));
  else {
    const reply = mode === 'unknown-operation'
      ? { operationId: 'different-operation', state: 'ready' }
      : mode === 'unknown-field'
        ? { operationId: plan.operationId, state: 'ready', completed: true }
        : { operationId: plan.operationId, state: 'ready' };
    process.stdout.write(`${JSON.stringify(reply)}\n`);
    // The native operation owns post-readiness work. Keep this child alive briefly
    // so tests can observe that the parent callback does not kill it after handoff.
    setTimeout(finish, 250);
  }
  if (mode !== 'ready') setInterval(() => {}, 1000);
} else {
  process.exitCode = 2;
}
