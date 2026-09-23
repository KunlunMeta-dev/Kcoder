// Test-only account-entry boundary. Identities are synthetic; this fixture tests
// Gateway authentication/routing, not Unix UID isolation. Runtime is the real CLI.
import { readFileSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { resolve, sep } from 'node:path';
const settings = JSON.parse(readFileSync(process.argv[2], 'utf8'));
let buffered = Buffer.alloc(0);
let child;
const timer = setTimeout(() => process.exit(2), 10000);
function reject() {
  process.stdout.write(JSON.stringify({ protocol: 'kcoder-account-v1', authenticated: false, errorCode: 'authentication_failed' }) + '\n');
  process.exitCode = 1;
  process.stdin.destroy();
}
function authenticate(chunk) {
  buffered = Buffer.concat([buffered, chunk]);
  if (buffered.length > 8192) { clearTimeout(timer); reject(); return; }
  const newline = buffered.indexOf(10);
  if (newline < 0) return;
  process.stdin.removeListener('data', authenticate);
  clearTimeout(timer);
  let auth;
  try { auth = JSON.parse(buffered.subarray(0, newline).toString()); } catch { reject(); return; }
  const account = settings.accounts.find(item => item.username === auth.username && item.password === auth.password);
  if (!account || auth.protocol !== 'kcoder-account-v1') { reject(); return; }
  const workspace = resolve(auth.workspace || settings.workspace);
  const root = resolve(settings.workspace);
  if (workspace !== root && !workspace.startsWith(root + sep)) { reject(); return; }
  process.stdout.write(JSON.stringify({ protocol: 'kcoder-account-v1', authenticated: true,
    username: account.username, principalId: account.principalId, uid: account.fixtureUid, role: 'user' }) + '\n');
  child = spawn(settings.binary, ['--cwd', workspace, 'app-server'], {
    cwd: workspace, env: { ...process.env, HOME: account.configDir, XDG_CONFIG_HOME: account.configDir, KCODER_CONFIG_DIR: account.configDir }, stdio: ['pipe', 'pipe', 'pipe'],
  });
  child.on('error', () => process.exit(2));
  child.stdout.pipe(process.stdout); child.stderr.pipe(process.stderr);
  child.on('exit', code => process.exit(code ?? 1));
  child.stdin.on('error', () => {});
  const remaining = buffered.subarray(newline + 1);
  if (remaining.length) child.stdin.write(Buffer.from(remaining));
  buffered.fill(0); buffered = Buffer.alloc(0); auth = null;
  process.stdin.pipe(child.stdin);
}
process.stdin.on('data', authenticate);
for (const signal of ['SIGTERM', 'SIGINT']) process.on(signal, () => {
  clearTimeout(timer);
  if (child) child.kill(signal);
  else process.exit(0);
});
