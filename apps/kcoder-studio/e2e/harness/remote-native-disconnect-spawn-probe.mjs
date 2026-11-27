// Owned local no-network subprocess used only to validate preload plumbing.
import { spawn } from 'node:child_process';
const child = spawn('/usr/bin/ssh', ['-V', 'kcoder-native-acp-image-v1:local-no-network-probe'], {
  stdio: ['pipe', 'pipe', 'pipe'],
});
let failed = false;
child.stdin.on('error', () => { failed = true; process.exitCode = 1; });
child.stdin.end();
child.stdout.resume();
child.stderr.resume();
child.on('error', () => { failed = true; process.exitCode = 1; });
const timer = setTimeout(() => { failed = true; process.exitCode = 1; if (child.pid) child.kill('SIGKILL'); }, 3000);
timer.unref();
child.on('close', (code, signal) => {
  clearTimeout(timer);
  if (failed || code !== 0 || signal) { process.exitCode = 1; process.stdout.write('owned-spawn-probe-failed\n'); }
  else process.stdout.write('owned-spawn-probe-complete\n');
});
