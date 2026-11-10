// Owned local no-network subprocess used only to validate preload plumbing.
import { spawn } from 'node:child_process';
const child = spawn('/usr/bin/ssh', ['-V', 'kcoder-native-acp-image-v1:local-no-network-probe'], {
  stdio: ['pipe', 'pipe', 'pipe'],
});
child.stdin.end();
child.stdout.resume();
child.stderr.resume();
child.on('error', () => { process.exitCode = 1; });
child.on('close', () => { process.stdout.write('owned-spawn-probe-complete\n'); });
