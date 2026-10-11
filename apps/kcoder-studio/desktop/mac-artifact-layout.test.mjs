import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import test from 'node:test';
import { inspectMacApplication, macApplicationPath, verifyMacReleaseManifest, writeMacReleaseManifest } from './mac-artifact-layout.mjs';

// Model-independent bundle/manifest safety. The ASAR entry reader is injected;
// its archive decoding and public path checks have their own release tests.
async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'kcoder-mac-layout-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const bundle = join(root, 'KCoder Studio.app');
  const put = async (name, body) => { const path = join(bundle, name); await mkdir(join(path, '..'), { recursive: true }); await writeFile(path, body); };
  for (const [name, body] of [
    ['Contents/Info.plist', 'fixture app metadata'],
    ['Contents/MacOS/KCoder Studio', 'fixture host'],
    ['Contents/Resources/app.asar', 'fixture asar'],
    ['Contents/Resources/bin/kcoder', 'fixture sidecar'],
    ['Contents/Resources/bin/chrome/chrome-mac-x64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing', 'fixture browser'],
    ['Contents/Resources/bin/pdf/pdftotext', 'fixture reader'],
    ['Contents/Resources/bin/pdf/xpdfrc', 'fixture character-map configuration'],
    ['Contents/Resources/bin/pdf/.kcoder-pdf.json', '{}'],
    ['Contents/Resources/gateway/dev-server.mjs', 'export const fixture = true;'],
    ['Contents/Resources/renderer-dist/index.html', '<html>fixture</html>'],
    ['Contents/Frameworks/Electron Framework.framework/Versions/A/Electron Framework', 'fixture framework'],
    ['Contents/Frameworks/Electron Framework.framework/Versions/A/Resources/en.lproj/locale.pak', 'fixture locale'],
  ]) await put(name, body);
  const framework = join(bundle, 'Contents/Frameworks/Electron Framework.framework');
  await mkdir(join(framework, 'Versions/A/Helpers'), { recursive: true });
  await symlink('A', join(framework, 'Versions/Current'));
  await symlink('Versions/Current/Electron Framework', join(framework, 'Electron Framework'));
  await symlink('Versions/Current/Helpers', join(framework, 'Helpers'));
  await symlink('Versions/Current/Resources', join(framework, 'Resources'));
  const context = { electronPlatformName: 'darwin', appOutDir: root, packager: { appInfo: { productFilename: 'KCoder Studio', id: 'dev.kcoder.studio' }, info: { framework: { version: '42.3.3' } } } };
  const options = { inspectAsar: async () => ['desktop/main.mjs'], identity: { packagingSource: { commit: 'a'.repeat(40), dirty: false } } };
  return { root, bundle, context, options, put, framework };
}

test('macOS manifests cover canonical framework files, explicit links and the full Resources directory', async t => {
  const { bundle, context, options } = await fixture(t);
  assert.equal(macApplicationPath(context), bundle);
  const manifest = await writeMacReleaseManifest(context, options);
  assert.equal(manifest.platform, 'darwin');
  assert.equal(manifest.hostRuntime.frameworkLinks.length, 4);
  assert.ok(manifest.hostRuntime.frameworkLinks.some(link => link.path.endsWith('/Electron Framework.framework/Helpers') && link.target === 'Versions/Current/Helpers'));
  assert.ok(manifest.hostRuntime.bundleFiles.some(file => file.path.endsWith('/locale.pak')));
  assert.ok(manifest.resources.some(file => file.path === 'bin/kcoder'));
  await verifyMacReleaseManifest(bundle, options);
  await writeFile(join(bundle, 'Contents/MacOS/KCoder Studio'), 'changed host');
  await assert.rejects(verifyMacReleaseManifest(bundle, options), /files or framework links/);
});

test('unexpected or escaping framework links and resource symlinks fail the macOS audit', async t => {
  const { bundle, options, framework, root } = await fixture(t);
  await symlink(join(root, 'outside'), join(bundle, 'Contents/Resources/link'));
  await assert.rejects(inspectMacApplication(bundle, options), /Unexpected macOS framework link/);
  await rm(join(bundle, 'Contents/Resources/link'));
  await rm(join(framework, 'Versions/Current'));
  await symlink('../outside', join(framework, 'Versions/Current'));
  await assert.rejects(inspectMacApplication(bundle, options), /Unexpected macOS framework link/);
});

test('Electron Framework Helpers accepts only its canonical in-bundle link target', async t => {
  const { bundle, options, framework } = await fixture(t);
  const layout = await inspectMacApplication(bundle, options);
  assert.deepEqual(layout.frameworkLinks.find(link => link.path.endsWith('/Electron Framework.framework/Helpers')),
    { path: 'Contents/Frameworks/Electron Framework.framework/Helpers', target: 'Versions/Current/Helpers' });

  await rm(join(framework, 'Helpers'));
  await symlink('Versions/Current/Other', join(framework, 'Helpers'));
  await assert.rejects(inspectMacApplication(bundle, options), /Unexpected macOS framework link/);
});

test('Electron Framework Helpers cannot resolve through a link that escapes the application', async t => {
  const { bundle, options, framework, root } = await fixture(t);
  const helperDirectory = join(framework, 'Versions/A/Helpers');
  await rm(helperDirectory, { recursive: true });
  const outside = join(root, 'outside-helpers');
  await mkdir(outside);
  await symlink(outside, helperDirectory);
  await assert.rejects(inspectMacApplication(bundle, options), /Unexpected macOS framework link|escapes its application/);
});

test('bundle ancestor aliases are canonicalized while a symlink bundle root stays rejected', async t => {
  const { bundle, options, root } = await fixture(t);
  const parentAlias = join(root, 'parent-alias');
  await symlink(root, parentAlias);
  const aliasLayout = await inspectMacApplication(join(parentAlias, basename(bundle)), options);
  assert.equal(aliasLayout.frameworkLinks.length, 4);

  const bundleAlias = join(root, 'bundle-root-alias.app');
  await symlink(bundle, bundleAlias);
  await assert.rejects(inspectMacApplication(bundleAlias, options), /macOS application must be a real directory/);
});

test('macOS packaging retains missing-resource and forbidden ASAR/file checks', async t => {
  const { bundle, context, options, put } = await fixture(t);
  await assert.rejects(writeMacReleaseManifest(context, { ...options, inspectAsar: async () => ['.env'] }), /forbidden resource path/);
  await put('Contents/Resources/credentials.json', '{}');
  await assert.rejects(writeMacReleaseManifest(context, options), /forbidden resource path/);
  await rm(join(bundle, 'Contents/Resources/credentials.json'));
  await rm(join(bundle, 'Contents/Resources/bin/kcoder'));
  await assert.rejects(writeMacReleaseManifest(context, options), /missing Contents\/Resources\/bin\/kcoder/);
});
