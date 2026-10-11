import { execFile as callback } from 'node:child_process';
import { promisify } from 'node:util';
import { writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';

const execFile = promisify(callback);
const [artifactDirectory] = process.argv.slice(2);
if (!artifactDirectory) throw new Error('An owned artifact directory is required');
const cli = resolve('apps/kcoder-studio/renderer/scripts/ai-verify.mjs');
let session;
const result = { ready: false, appearanceVerified: false, stopped: false };
async function command(action, args = []) {
  const response = await execFile(process.execPath, [cli, action, ...(session ? ['--session', session] : []), ...args],
    { timeout: action === 'start' ? 75000 : 15000, maxBuffer: 1024 * 1024 });
  return response.stdout;
}
try {
  const started = JSON.parse(await command('start', ['--timeout', '60000']));
  session = started.session;
  result.ready = true;
  await writeFile(resolve(artifactDirectory, 'tauri-initial-snapshot.json'), await command('snapshot', ['--timeout', '5000']));
  await command('navigate', ['--value', '/settings/appearance', '--timeout', '5000']);
  await command('wait-for', ['--selector', '[data-testid="appearance-settings-page"]', '--visible', 'true', '--timeout', '5000']);
  await command('click', ['--selector', '[data-testid="appearance-mode-dark"]', '--timeout', '5000']);
  await command('capture', ['--output', resolve(artifactDirectory, 'tauri-appearance.png'), '--timeout', '5000']);
  result.appearanceVerified = true;
} catch (error) {
  result.error = String(error.stderr || error.message).slice(0, 1500);
} finally {
  if (session) {
    try { await command('stop'); result.stopped = true; }
    catch { result.cleanupError = 'Tauri session stop failed'; }
  }
  await writeFile(resolve(artifactDirectory, 'tauri-result.json'), JSON.stringify(result, null, 2));
}
if (!result.appearanceVerified || !result.stopped) process.exitCode = 1;
