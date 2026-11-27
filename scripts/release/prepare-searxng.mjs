import { spawn } from 'node:child_process';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repository = resolve(fileURLToPath(new URL('../..', import.meta.url)));

/** Build-time only: end users run the sealed interpreter shipped in the package. */
export async function prepareSearxng({ platform, destination, env = process.env } = {}) {
  if (!['linux-x64', 'win-x64', 'mac-x64', 'mac-arm64'].includes(platform)) throw new Error('Unsupported bundled SearXNG platform');
  if (!destination) throw new Error('A dedicated SearXNG destination is required');
  const args = [resolve(repository, 'scripts/searxng/prepare.py'), '--platform', platform, '--destination', resolve(destination)];
  if (env.KCODER_SEARXNG_CACHE) args.push('--cache', resolve(env.KCODER_SEARXNG_CACHE));
  if (env.KCODER_SEARXNG_UV) args.push('--uv', env.KCODER_SEARXNG_UV);
  await new Promise((accept, reject) => {
    const child = spawn(env.KCODER_BUILD_PYTHON || 'python3', args, { cwd: repository, env, stdio: 'inherit', shell: false });
    child.once('error', reject);
    child.once('exit', (code, signal) => code === 0 ? accept() : reject(new Error(`Bundled SearXNG preparation failed (${signal ?? code}); Python 3.12+ and uv 0.12.17 are required on the build host`)));
  });
  return { directory: resolve(destination), platform };
}
