import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runInNewContext } from 'node:vm';
import test from 'node:test';
import { build, loadConfigFromFile } from 'vite';

const renderer = resolve(dirname(fileURLToPath(import.meta.url)), '..');

test('production Vite configuration unifies React across linked dependency trees', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'kcoder-react-singleton-'));
  try {
    const app = join(directory, 'app');
    const peer = join(directory, 'linked-peer');
    for (const [root, label] of [[app, 'app'], [peer, 'peer']]) {
      for (const name of ['react', 'react-dom']) {
        const dependency = join(root, 'node_modules', name);
        await mkdir(dependency, { recursive: true });
        await writeFile(join(dependency, 'package.json'), JSON.stringify({ name, version: '1.0.0', type: 'module', main: 'index.js' }));
        await writeFile(join(dependency, 'index.js'), `export const identity = ${JSON.stringify(`${label}-${name}`)};\n`);
      }
    }
    await writeFile(join(peer, 'component.js'), "import { identity as r } from 'react'; import { identity as d } from 'react-dom'; export const peer = [r, d];\n");
    const entry = join(app, 'entry.js');
    await writeFile(entry, "import { identity as r } from 'react'; import { identity as d } from 'react-dom'; import { peer } from '../linked-peer/component.js'; globalThis.result = [r, d, ...peer];\n");

    const loaded = await loadConfigFromFile({ command: 'build', mode: 'test' }, join(renderer, 'vite.config.ts'), renderer, 'silent');
    assert.ok(loaded, 'The actual renderer configuration must load');
    const bundle = async dedupe => {
      const output = await build({ configFile: false, root: app, logLevel: 'silent', resolve: { dedupe },
        build: { write: false, minify: false, lib: { entry, name: 'SingletonProbe', formats: ['iife'] } } });
      const generated = Array.isArray(output) ? output[0] : output;
      const chunk = generated.output.find(item => item.type === 'chunk');
      assert.ok(chunk, 'Vite must emit the actual linked dependency graph');
      const scope = {};
      runInNewContext(chunk.code, { globalThis: scope });
      return Array.from(scope.result);
    };
    assert.deepEqual(await bundle([]), ['app-react', 'app-react-dom', 'peer-react', 'peer-react-dom'],
      'The fixture must reproduce separate peer dependencies without deduplication');
    assert.deepEqual(await bundle(loaded.config.resolve?.dedupe ?? []),
      ['app-react', 'app-react-dom', 'app-react', 'app-react-dom']);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
