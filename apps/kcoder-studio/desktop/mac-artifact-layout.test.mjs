import assert from 'node:assert/strict';
import { link, lstat, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import test from 'node:test';
import { inspectMacApplication, macApplicationPath, normalizeMacApplicationPermissions, verifyMacReleaseManifest, writeMacReleaseManifest } from './mac-artifact-layout.mjs';
import { stampCliReleaseMetadata } from '../../../scripts/release/cli-release-metadata.mjs';

const fixtureCommit = 'a'.repeat(40);
const fixtureVersions = { cli: '2.0.47', cliNative: '0.1.0', studio: '2.0.47', mobile: '2.0.47' };

// Release manifests accept only a sidecar carrying stamped release metadata that
// matches the packaging identity, so the fixture stamps its own owned binary
// instead of relying on any locally built CLI.
async function stampedSidecar(path) {
  const binary = Buffer.alloc(4200);
  (await readFile(new URL('../../../crates/kcoder_cli/release-metadata-marker.txt', import.meta.url))).copy(binary, 64);
  await writeFile(path, binary);
  await stampCliReleaseMetadata(path, { schemaVersion: 1,
    release: { version: fixtureVersions.cli, commit: fixtureCommit, dirty: false, timeUnix: 42 },
    native: { version: fixtureVersions.cliNative, commit: 'c'.repeat(40), dirty: false, timeUnix: 1, artifactSha256: createHash('sha256').update(binary).digest('hex') } });
}

// Model-independent bundle/manifest safety. The ASAR entry reader is injected;
// its archive decoding and public path checks have their own release tests.
async function fixture(t, arch = 'x64') {
  const root = await mkdtemp(join(tmpdir(), 'kcoder-mac-layout-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const bundle = join(root, 'KCoder Studio.app');
  const put = async (name, body) => { const path = join(bundle, name); await mkdir(join(path, '..'), { recursive: true }); await writeFile(path, body); };
  for (const [name, body] of [
    ['Contents/Info.plist', 'fixture app metadata'],
    ['Contents/MacOS/KCoder Studio', 'fixture host'],
    ['Contents/Resources/app.asar', 'fixture asar'],
    [`Contents/Resources/bin/chrome/chrome-mac-${arch}/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing`, 'fixture browser'],
    ['Contents/Resources/bin/pdf/pdftotext', 'fixture reader'],
    ['Contents/Resources/bin/pdf/xpdfrc', 'fixture character-map configuration'],
    ['Contents/Resources/bin/pdf/.kcoder-pdf.json', '{}'],
    ['Contents/Resources/gateway/dev-server.mjs', 'export const fixture = true;'],
    ['Contents/Resources/renderer-dist/index.html', '<html>fixture</html>'],
    ['Contents/Frameworks/Electron Framework.framework/Versions/A/Electron Framework', 'fixture framework'],
    ['Contents/Frameworks/Electron Framework.framework/Versions/A/Resources/en.lproj/locale.pak', 'fixture locale'],
  ]) await put(name, body);
  await stampedSidecar(join(bundle, 'Contents/Resources/bin/kcoder'));
  const framework = join(bundle, 'Contents/Frameworks/Electron Framework.framework');
  await mkdir(join(framework, 'Versions/A/Helpers'), { recursive: true });
  await symlink('A', join(framework, 'Versions/Current'));
  await symlink('Versions/Current/Electron Framework', join(framework, 'Electron Framework'));
  await symlink('Versions/Current/Helpers', join(framework, 'Helpers'));
  await symlink('Versions/Current/Resources', join(framework, 'Resources'));
  const context = { electronPlatformName: 'darwin', arch: arch === 'arm64' ? 3 : 1, appOutDir: root, packager: { appInfo: { productFilename: 'KCoder Studio', id: 'dev.kcoder.studio' }, info: { framework: { version: '42.3.3' } } } };
  const options = { inspectAsar: async () => ['desktop/main.mjs'], identity: { versions: fixtureVersions, packagingSource: { commit: fixtureCommit, dirty: false } } };
  return { root, bundle, context, options, put, framework };
}

test('ARM64 manifest verification retains architecture and rejects a mismatched Chrome tree', async t => {
  const { bundle, context, options } = await fixture(t, 'arm64');
  const manifest = await writeMacReleaseManifest(context, options);
  assert.equal(manifest.hostRuntime.architecture, 'arm64');
  await verifyMacReleaseManifest(bundle, options);
  await assert.rejects(verifyMacReleaseManifest(bundle, { ...options, arch: 'x64' }), /architecture/);
  await assert.rejects(inspectMacApplication(bundle, { ...options, arch: 'x64' }), /missing.*chrome-mac-x64/);
});

test('macOS manifests cover canonical framework files, explicit links and the full Resources directory', async t => {
  const { bundle, context, options } = await fixture(t);
  assert.equal(macApplicationPath(context), bundle);
  const manifest = await writeMacReleaseManifest(context, options);
  assert.equal(manifest.platform, 'darwin');
  assert.equal(manifest.hostRuntime.frameworkLinks.length, 4);
  assert.ok(manifest.hostRuntime.frameworkLinks.some(link => link.path.endsWith('/Electron Framework.framework/Helpers') && link.target === 'Versions/Current/Helpers'));
  assert.ok(manifest.hostRuntime.bundleFiles.some(file => file.path.endsWith('/locale.pak')));
  assert.ok(manifest.resources.some(file => file.path === 'bin/kcoder'));
  assert.equal(manifest.nativeBuild.commit, 'c'.repeat(40));
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

test('the signed manifest excludes only its circular outer seal and host image', async t => {
  const { bundle, context, options, put } = await fixture(t);
  // The fixture executable uses the actual bundle filename expected by codesign.
  await put('Contents/_CodeSignature/CodeResources', 'outer signature fixture');
  await put('Contents/MacOS/additional-helper', 'inventoried helper');
  const manifest = await writeMacReleaseManifest(context, { ...options, codeSigning: 'ad-hoc' });
  assert.equal(manifest.hostRuntime.codeSigning, 'ad-hoc');
  assert.ok(!manifest.hostRuntime.bundleFiles.some(file => file.path === 'Contents/MacOS/KCoder Studio'));
  assert.ok(!manifest.hostRuntime.bundleFiles.some(file => file.path === 'Contents/_CodeSignature/CodeResources'));
  assert.ok(manifest.hostRuntime.bundleFiles.some(file => file.path === 'Contents/MacOS/additional-helper'));
  assert.ok(manifest.hostRuntime.bundleFiles.some(file => file.path.endsWith('/Electron Framework')));
  assert.ok(manifest.resources.some(file => file.path === 'bin/kcoder'));
  // A signed manifest must require native verification, never silently degrade
  // to a resource-only check. This fake host/seal is deliberately invalid.
  await assert.rejects(verifyMacReleaseManifest(bundle, options));
});

test('bundle normalization leaves the application executable runnable', async t => {
  const { bundle } = await fixture(t);
  await normalizeMacApplicationPermissions(bundle);
  assert.notEqual((await lstat(join(bundle, 'Contents/MacOS/KCoder Studio'))).mode & 0o111, 0);
  assert.ok((await lstat(join(bundle, 'Contents/Frameworks/Electron Framework.framework/Electron Framework'))).isSymbolicLink());
});

test('bundle normalization rejects an external hard link without changing its bytes', async t => {
  const { bundle, root } = await fixture(t);
  const outside = join(root, 'outside-data');
  const original = 'external bytes stay intact';
  const bundled = join(bundle, 'Contents/Resources/public-copy.bin');
  await writeFile(outside, original);
  await link(outside, bundled);
  await assert.rejects(normalizeMacApplicationPermissions(bundle), /hard-linked/);
  assert.equal(await readFile(outside, 'utf8'), original);
  assert.equal((await lstat(outside)).ino, (await lstat(bundled)).ino);
});

test('native ad-hoc seals reject changed resources and a changed host image', { skip: process.platform !== 'darwin' }, async t => {
  const { bundle, context, options, put, framework } = await fixture(t, process.arch === 'arm64' ? 'arm64' : 'x64');
  await rm(framework, { recursive: true });
  await put('Contents/Info.plist', `<?xml version="1.0" encoding="UTF-8"?>
<plist version="1.0"><dict><key>CFBundleExecutable</key><string>KCoder Studio</string>
<key>CFBundleIdentifier</key><string>dev.kcoder.signature-fixture</string>
<key>CFBundlePackageType</key><string>APPL</string></dict></plist>`);
  const host = join(bundle, 'Contents/MacOS/KCoder Studio');
  execFileSync('/usr/bin/xcrun', ['clang', '-x', 'c', '-', '-o', host], { input: 'int main(void) { return 0; }' });
  const seal = () => execFileSync('/usr/bin/codesign', ['--force', '--sign', '-', '--timestamp=none', bundle]);
  seal();
  await writeMacReleaseManifest(context, { ...options, codeSigning: 'ad-hoc' });
  seal();
  await normalizeMacApplicationPermissions(bundle, options);
  await verifyMacReleaseManifest(bundle, options);
  const resource = join(bundle, 'Contents/Resources/gateway/dev-server.mjs');
  const original = await readFile(resource);
  await writeFile(resource, 'changed resource');
  await assert.rejects(verifyMacReleaseManifest(bundle, options), /codesign/);
  await writeFile(resource, original);
  await verifyMacReleaseManifest(bundle, options);
  const image = await readFile(host);
  image[4096] ^= 1;
  await writeFile(host, image);
  await assert.rejects(verifyMacReleaseManifest(bundle, options), /codesign/);
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

test('macOS manifests reject an unstamped or mismatched CLI sidecar', async t => {
  const { bundle, context, options } = await fixture(t);
  await assert.rejects(writeMacReleaseManifest(context, { ...options, identity: { ...options.identity, packagingSource: { commit: 'b'.repeat(40), dirty: false } } }), /metadata does not match/);
  await writeFile(join(bundle, 'Contents/Resources/bin/kcoder'), 'unstamped sidecar');
  await assert.rejects(writeMacReleaseManifest(context, options), /no unique release metadata slot/);
});
