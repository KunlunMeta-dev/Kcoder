import { lstat, readdir, readFile, readlink, realpath } from 'node:fs/promises';
import { basename, isAbsolute, relative, resolve, sep } from 'node:path';
import { chromeRelease } from '../../../scripts/release/prepare-chrome.mjs';
import { isMacChromeFrameworkLink } from '../../../scripts/release/mac-chrome-links.mjs';
import { assertPublicPath, inventory, manifestName, verifyManifest, writeManifest } from '../../../scripts/release/artifact-manifest.mjs';

const frameworks = new Set(['Electron Framework', 'Mantle', 'ReactiveObjC', 'Squirrel']);

export function macApplicationPath(context) {
  const name = context?.packager?.appInfo?.productFilename;
  if (typeof name !== 'string' || !name || basename(name) !== name || /[\\/\0]/.test(name)) {
    throw new Error('macOS release requires a valid application bundle name');
  }
  return resolve(context.appOutDir, `${name}.app`);
}

function permittedFrameworkLink(path, target) {
  const chromePrefix = 'Contents/Resources/bin/chrome/';
  if (path.startsWith(chromePrefix)) return isMacChromeFrameworkLink(path.slice(chromePrefix.length), target, chromeRelease('mac-x64'));
  const match = /^Contents\/Frameworks\/([^/]+)\.framework\/(.+)$/.exec(path);
  if (!match || !frameworks.has(match[1])) return false;
  const member = match[2];
  if (member === 'Versions/Current') return target === 'A';
  if (member === 'Helpers') return match[1] === 'Electron Framework' && target === 'Versions/Current/Helpers';
  return [match[1], 'Resources', 'Libraries', 'Headers', 'Modules'].includes(member)
    && target === `Versions/Current/${member}`;
}

/** Audit canonical files and explicitly bounded framework links; never follow
 * symlinks while walking or relax the ordinary resource inventory boundary. */
export async function inspectMacApplication(bundle, options = {}) {
  bundle = resolve(bundle);
  const bundleInfo = await lstat(bundle);
  if (bundleInfo.isSymbolicLink() || !bundleInfo.isDirectory()) {
    throw new Error('macOS application must be a real directory');
  }
  // macOS commonly exposes the same temporary tree through /tmp and /private/tmp.
  // Resolve the checked directory itself before comparing framework link targets;
  // the lstat above still rejects a bundle root that is itself a symlink.
  bundle = await realpath(bundle);
  const files = [];
  const frameworkLinks = [];
  async function visit(prefix = '') {
    for (const name of (await readdir(resolve(bundle, prefix))).sort()) {
      const path = prefix ? `${prefix}/${name}` : name;
      if (path === `Contents/Resources/${manifestName}`) continue;
      assertPublicPath(path);
      const full = resolve(bundle, path);
      const info = await lstat(full);
      if (info.isSymbolicLink()) {
        const target = await readlink(full);
        if (isAbsolute(target) || !permittedFrameworkLink(path, target)) throw new Error(`Unexpected macOS framework link: ${path}`);
        frameworkLinks.push({ path, target });
      } else if (info.isDirectory()) await visit(path);
      else if (info.isFile()) files.push(path);
      else throw new Error(`Unsupported macOS application resource: ${path}`);
    }
  }
  await visit();
  for (const link of frameworkLinks) {
    const resolved = relative(bundle, await realpath(resolve(bundle, link.path)));
    if (isAbsolute(resolved) || resolved === '..' || resolved.startsWith(`..${sep}`)) throw new Error(`macOS framework link escapes its application: ${link.path}`);
  }
  const required = ['Contents/Resources/app.asar', 'Contents/Resources/gateway/dev-server.mjs', 'Contents/Resources/renderer-dist/index.html'];
  if (options.requireSidecar !== false) required.push('Contents/Resources/bin/kcoder');
  if (options.requireLocalResources !== false) required.push(
    'Contents/Resources/bin/chrome/chrome-mac-x64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing',
    'Contents/Resources/bin/pdf/pdftotext', 'Contents/Resources/bin/pdf/xpdfrc', 'Contents/Resources/bin/pdf/.kcoder-pdf.json',
  );
  for (const path of required) if (!files.includes(path)) throw new Error(`macOS application is missing ${path}`);
  const canonical = await inventory(bundle, { files, ...(options.inspectAsar ? { inspectAsar: options.inspectAsar } : {}) });
  return { frameworkLinks, resourceFiles: canonical.filter(file => file.path.startsWith('Contents/Resources/')).map(file => file.path.slice('Contents/Resources/'.length)), bundleFiles: canonical.filter(file => !file.path.startsWith('Contents/Resources/')) };
}

export async function writeMacReleaseManifest(context, options = {}) {
  const bundle = macApplicationPath(context);
  const kind = context.packager.appInfo.id === 'dev.kcoder.studio.remote' ? 'studio-remote' : 'studio-desktop';
  const layout = await inspectMacApplication(bundle, { ...options, requireSidecar: kind !== 'studio-remote', requireLocalResources: kind !== 'studio-remote' });
  return writeManifest(resolve(bundle, 'Contents/Resources'), {
    kind, platform: 'darwin', ...options, files: layout.resourceFiles,
    hostRuntime: {
      kind: 'electron', version: context.packager.info.framework.version,
      inventoryBoundary: 'Contents/Resources and canonical application files; framework link targets are explicit; final installer checksum covers the complete application',
      frameworkLinks: layout.frameworkLinks, bundleFiles: layout.bundleFiles,
    },
  });
}

export async function verifyMacReleaseManifest(bundle, options = {}) {
  const prior = JSON.parse(await readFile(resolve(bundle, 'Contents/Resources', manifestName), 'utf8'));
  const actual = await inspectMacApplication(bundle, { ...options, requireSidecar: prior.kind !== 'studio-remote', requireLocalResources: prior.kind !== 'studio-remote' });
  const manifest = await verifyManifest(resolve(bundle, 'Contents/Resources'), { ...options, files: actual.resourceFiles });
  if (JSON.stringify(actual.frameworkLinks) !== JSON.stringify(manifest.hostRuntime?.frameworkLinks)
    || JSON.stringify(actual.bundleFiles) !== JSON.stringify(manifest.hostRuntime?.bundleFiles)) {
    throw new Error('macOS application files or framework links do not match the release manifest');
  }
  return manifest;
}
