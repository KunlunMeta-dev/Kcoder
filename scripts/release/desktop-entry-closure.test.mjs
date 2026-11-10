import assert from 'node:assert/strict';
import { copyFile, glob, mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { finished } from 'node:stream/promises';
import { verifyDesktopEntryClosure, verifyGatewayEntryClosure } from './desktop-entry-closure.mjs';
import releaseArtifactHook from '../../apps/kcoder-studio/desktop/release-artifact-hook.mjs';

test('external Gateway closure rejects missing remote controls and their generated schema', async t => {
  const root = await mkdtemp(join(tmpdir(), 'kcoder-gateway-closure-'));
  t.after(() => rm(root, {recursive:true,force:true}));
  await mkdir(join(root, 'gateway/shared/remotes'), {recursive:true});
  await writeFile(join(root, 'gateway/dev-server.mjs'), "import './shared/remotes/controlContracts.mjs';");
  assert.throws(() => verifyGatewayEntryClosure(root), /controlContracts\.mjs/);
  await writeFile(join(root, 'gateway/shared/remotes/controlContracts.mjs'), "import schemas from '../generated/schemas.integrations-remotes.json' with {type:'json'}; export {schemas};");
  assert.throws(() => verifyGatewayEntryClosure(root), /schemas\.integrations-remotes\.json/);
  await mkdir(join(root, 'gateway/shared/generated'));
  await writeFile(join(root, 'gateway/shared/generated/schemas.integrations-remotes.json'), '{}');
  assert.equal(verifyGatewayEntryClosure(root).files.length, 3);
  await writeFile(join(root, 'gateway/dev-server.mjs'), "import '../';");
  assert.throws(() => verifyGatewayEntryClosure(root), /escapes resources/);
});

test('external Gateway closure follows the packaged sibling relay identity module', async t => {
  const root = await mkdtemp(join(tmpdir(), 'kcoder-gateway-relay-closure-'));
  t.after(() => rm(root, {recursive:true,force:true}));
  await mkdir(join(root, 'gateway/src/remotes'), {recursive:true});
  await writeFile(join(root, 'gateway/dev-server.mjs'), "export * from './src/remotes/observations.mjs';");
  await writeFile(join(root, 'gateway/src/remotes/observations.mjs'), "import '../../../kcoder-relay/src/client-identity.mjs';");
  assert.throws(() => verifyGatewayEntryClosure(root), /kcoder-relay/);
  await mkdir(join(root, 'kcoder-relay/src'), {recursive:true});
  await writeFile(join(root, 'kcoder-relay/src/client-identity.mjs'), "import {createHash} from 'node:crypto'; export {createHash};");
  assert.equal(verifyGatewayEntryClosure(root).files.length, 3);
});

test('external Gateway closure rejects a directory link before reading its module', async t => {
  const root = await mkdtemp(join(tmpdir(), 'kcoder-gateway-linked-'));
  t.after(() => rm(root, {recursive:true,force:true}));
  const resources = join(root, 'resources');
  await mkdir(join(resources, 'gateway'), {recursive:true});
  await mkdir(join(root, 'outside'));
  await writeFile(join(resources, 'gateway/dev-server.mjs'), "import './shared/private.mjs';");
  await writeFile(join(root, 'outside/private.mjs'), 'export const outside = true;');
  try { await symlink(join(root, 'outside'), join(resources, 'gateway/shared'), 'dir'); }
  catch (error) { if (error.code === 'EPERM' && process.platform === 'win32') return t.skip('Native directory symlink permission unavailable'); throw error; }
  assert.throws(() => verifyGatewayEntryClosure(resources), /unsafe directory/);
});

async function archive(t, files) {
  const root = await mkdtemp(join(tmpdir(), 'kcoder-desktop-closure-'));
  t.after(() => rm(root, {recursive:true,force:true}));
  const source = join(root, 'app');
  await mkdir(source);
  for (const [path, contents] of Object.entries({'package.json':JSON.stringify({main:'desktop/main.mjs'}),...files})) {
    const target = join(source, path);
    await mkdir(join(target, '..'), {recursive:true});
    await writeFile(target, contents);
  }
  const host = createRequire(new URL('../../apps/kcoder-studio/package.json', import.meta.url));
  const builder = createRequire(host.resolve('electron-builder'));
  const library = createRequire(builder.resolve('app-builder-lib'));
  const target = join(root, 'app.asar');
  const output = await library('@electron/asar').createPackage(source, target);
  // ASAR 3 returns the ended stream before its last buffered file is flushed.
  if (output && typeof output.on === 'function') await finished(output);
  return target;
}

test('actual ASAR refuses a missing transitive entry import even when the source exists elsewhere', async t => {
  const path = await archive(t, {'desktop/main.mjs':"import './host.mjs';",'desktop/host.mjs':"import './native-component-image.mjs';"});
  assert.throws(() => verifyDesktopEntryClosure(path), /host.mjs -> desktop\/native-component-image.mjs/);
});

test('Electron file matchers retain the startup helper despite extraResources exclusions', async t => {
  const root = fileURLToPath(new URL('../../apps/kcoder-studio/', import.meta.url));
  const config = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
  const host = createRequire(join(root, 'package.json'));
  const builder = createRequire(host.resolve('electron-builder'));
  const { getMainFileMatchers, getFileMatchers } = builder('app-builder-lib/out/fileMatcher.js');
  const output = await mkdtemp(join(tmpdir(), 'kcoder-builder-inventory-'));
  t.after(() => rm(output, { recursive: true, force: true }));
  async function inventory(build) {
    const destination = join(output, 'app');
    const macroExpander = value => value.replaceAll('${arch}', 'arm64').replaceAll('${os}', 'mac');
    const options = { defaultSrc: root, macroExpander, customBuildOptions: build.mac ?? {}, globalOutDir: output };
    const excludes = [];
    // electron-builder excludes extraResources sources from every ASAR matcher.
    for (const matcher of getFileMatchers(build, 'extraResources', output, options) ?? []) {
      matcher.computeParsedPatterns(excludes, root);
    }
    const matchers = getMainFileMatchers(root, destination, macroExpander, options.customBuildOptions,
      { info: { projectDir: root, buildResourcesDir: 'build', config: build } }, output, false);
    const files = {};
    for (const matcher of matchers) {
      matcher.excludePatterns = excludes;
      const filter = matcher.createFilter();
      for await (const path of glob(matcher.patterns.filter(pattern => !pattern.startsWith('!')), {
        cwd: matcher.from, exclude: matcher.patterns.filter(pattern => pattern.startsWith('!')).map(pattern => pattern.slice(1)),
      })) {
        const source = join(matcher.from, path);
        const metadata = await stat(source);
        if (metadata.isFile() && filter(source, metadata)) {
          files[relative(destination, join(matcher.to, path)).replaceAll('\\', '/')] = await readFile(source);
        }
      }
    }
    return files;
  }
  const legacy = { ...config.build, files: config.build.files.map(pattern =>
    typeof pattern === 'object' && pattern.from === 'src' ? 'src/studio-login-link.js' : pattern) };
  const oldArchive = await archive(t, await inventory(legacy));
  assert.throws(() => verifyDesktopEntryClosure(oldArchive), /src\/studio-login-link\.js/);
  const closure = verifyDesktopEntryClosure(await archive(t, await inventory(config.build)));
  assert.ok(closure.files.includes('src/studio-login-link.js'));
});

test('the macOS artifact hook rejects a broken desktop archive before creating its manifest', async t => {
  const broken = await archive(t, { 'desktop/main.mjs': "import './missing.mjs';" });
  const root = await mkdtemp(join(tmpdir(), 'kcoder-mac-closure-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const resources = join(root, 'Fixture.app/Contents/Resources');
  await mkdir(resources, { recursive: true });
  await copyFile(broken, join(resources, 'app.asar'));
  await assert.rejects(releaseArtifactHook({ electronPlatformName: 'darwin', appOutDir: root,
    packager: { appInfo: { productFilename: 'Fixture', id: 'dev.kcoder.studio' } },
  }), /Desktop archive dependency missing/);
});

test('actual ASAR traverses multiline exports, literal dynamic imports, CJS and preload URLs', async t => {
  const path = await archive(t, {'desktop/main.mjs':"export {\n value\n} from './host.mjs'; import('./dynamic.cjs'); new URL('./preload.cjs',import.meta.url); new URL('../',import.meta.url); new URL('./',import.meta.url);",'desktop/host.mjs':'export const value=1;', 'desktop/dynamic.cjs':"require('./config.json');",'desktop/config.json':'{}','desktop/preload.cjs':"require('electron');"});
  assert.deepEqual(verifyDesktopEntryClosure(path).files,['desktop/config.json','desktop/dynamic.cjs','desktop/host.mjs','desktop/main.mjs','desktop/preload.cjs']);
});

test('actual ASAR closure accepts the Windows native listing separators', async t => {
  const path = await archive(t, {
    'desktop/main.mjs': "import './nested/host.mjs'; new URL('./nested/preload.cjs', import.meta.url);",
    'desktop/nested/host.mjs': 'export const value=1;',
    'desktop/nested/preload.cjs': "require('./config');",
    'desktop/nested/config.json': '{}',
  });
  const host = createRequire(new URL('../../apps/kcoder-studio/package.json', import.meta.url));
  const builder = createRequire(host.resolve('electron-builder'));
  const library = createRequire(builder.resolve('app-builder-lib'));
  const asar = library('@electron/asar');
  const list = asar.listPackage.bind(asar);
  t.mock.method(asar, 'listPackage', (...args) => list(...args).map(path => path.replaceAll('/', '\\')));
  assert.deepEqual(verifyDesktopEntryClosure(path).files, ['desktop/main.mjs', 'desktop/nested/config.json', 'desktop/nested/host.mjs', 'desktop/nested/preload.cjs']);
});

test('a literal module import must name a file even when its archive directory exists', async t => {
  const path = await archive(t, {'desktop/main.mjs':"import './folder/';",'desktop/folder/index.js':'export const value=1;'});
  assert.throws(() => verifyDesktopEntryClosure(path), /module dependency is a directory/);
});
