import { readdir } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

for (const directory of ['src', 'packaging', 'scripts']) {
  const root = new URL('../' + directory + '/', import.meta.url);
  for (const name of (await readdir(root)).filter(name => name.endsWith('.mjs')).sort()) {
    const result = spawnSync(process.execPath, ['--check', fileURLToPath(new URL(name, root))], { stdio: 'inherit' });
    if (result.error) throw result.error;
    if (result.status !== 0) process.exit(result.status ?? 1);
  }
}
