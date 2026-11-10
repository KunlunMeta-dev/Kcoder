import { createRequire } from 'node:module';
import { posix, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { lstatSync, readFileSync } from 'node:fs';
import { dirname, isAbsolute, relative } from 'node:path';

/** External Gateway modules are outside ASAR and need their own literal import closure. */
export function verifyGatewayEntryClosure(resources) {
  const ts = createRequire(new URL('../../apps/kcoder-studio/renderer/package.json', import.meta.url))('typescript');
  const root = resolve(resources);
  const rootInfo = lstatSync(root);
  if (!rootInfo.isDirectory() || rootInfo.isSymbolicLink()) throw Error('Gateway resources must be a regular directory');
  const visited = new Set();
  const visit = (path, caller) => {
    path = resolve(path);
    const key = relative(root, path);
    if (!key || key.startsWith('..') || isAbsolute(key)) throw Error(`Gateway dependency escapes resources: ${caller}`);
    for (let parent = dirname(path); parent !== root; parent = dirname(parent)) {
      let info;
      try { info = lstatSync(parent); } catch { throw Error(`Gateway dependency missing: ${caller} -> ${key}`); }
      if (!info.isDirectory() || info.isSymbolicLink()) throw Error(`Gateway dependency has an unsafe directory: ${key}`);
    }
    let info;
    try { info = lstatSync(path); } catch { throw Error(`Gateway dependency missing: ${caller} -> ${key}`); }
    if (!info.isFile() || info.isSymbolicLink()) throw Error(`Gateway dependency is not a regular file: ${key}`);
    if (visited.has(key)) return;
    if (visited.size >= 4096 || info.size > 4 * 1024 * 1024) throw Error('Gateway module closure limit exceeded');
    visited.add(key);
    if (!/\.[cm]?js$/.test(path)) return;
    const source = ts.createSourceFile(path, readFileSync(path, 'utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
    if (source.parseDiagnostics.length) throw Error(`Gateway module cannot be parsed: ${key}`);
    const dependency = value => { if (value.startsWith('.')) visit(resolve(dirname(path), value), key); };
    const scan = node => {
      if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) && node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier)) dependency(node.moduleSpecifier.text);
      if (ts.isCallExpression(node) && node.arguments.length && ts.isStringLiteral(node.arguments[0]) && node.expression.kind === ts.SyntaxKind.ImportKeyword) dependency(node.arguments[0].text);
      ts.forEachChild(node, scan);
    };
    scan(source);
  };
  visit(resolve(root, 'gateway/dev-server.mjs'), 'Gateway entry');
  return { files: [...visited].sort(), boundary: 'external literal relative ESM dependencies; bare packages and dynamic resource paths have separate inventories' };
}

/** Check literal module/URL dependencies against the actual archive, not source files. */
export function verifyDesktopEntryClosure(archive) {
  const host = createRequire(new URL('../../apps/kcoder-studio/package.json', import.meta.url));
  const builder = createRequire(host.resolve('electron-builder'));
  const library = createRequire(builder.resolve('app-builder-lib'));
  const asar = library('@electron/asar');
  const ts = createRequire(new URL('../../apps/kcoder-studio/renderer/package.json', import.meta.url))('typescript');
  const entries = new Set(asar.listPackage(archive).map(path => path.replaceAll('\\', '/').replace(/^\/+/, '')));
  const metadata = JSON.parse(asar.extractFile(archive, 'package.json').toString('utf8'));
  if (typeof metadata.main !== 'string' || !metadata.main) throw Error('Desktop archive has no main entry');
  const visited = new Set();
  const visit = (path, caller = 'package.json') => {
    path = posix.normalize(path);
    if (path.startsWith('../') || path.startsWith('/') || !entries.has(path))
      throw Error(`Desktop archive dependency missing: ${caller} -> ${path}`);
    const archivedPath = path.replaceAll('/', sep);
    const info = asar.statFile(archive, archivedPath, false);
    if (info.link) throw Error(`Desktop archive dependency is a link: ${path}`);
    if (info.files) throw Error(`Desktop archive module dependency is a directory: ${caller} -> ${path}`);
    if (visited.has(path)) return;
    visited.add(path);
    if (!/\.[cm]?js$/.test(path)) return;
    const source = ts.createSourceFile(path, asar.extractFile(archive, archivedPath).toString('utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
    if (source.parseDiagnostics.length) throw Error(`Desktop archive module cannot be parsed: ${path}`);
    const dependency = (value, commonJs = false, directoryUrl = false) => {
      if (!value.startsWith('.')) return;
      let target = posix.normalize(posix.join(posix.dirname(path), value)).replace(/\/+$/, '') || '.';
      if (directoryUrl && (target === '.' || [...entries].some(item => item.startsWith(target + '/')))) return;
      if (commonJs) target = [target, target + '.js', target + '.json', target + '/index.js'].find(item => entries.has(item) && !asar.statFile(archive, item.replaceAll('/', sep), false).files) ?? target;
      visit(target, path);
    };
    const scan = node => {
      if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) && node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier))
        dependency(node.moduleSpecifier.text);
      if (ts.isCallExpression(node) && node.arguments.length && ts.isStringLiteral(node.arguments[0])) {
        if (node.expression.kind === ts.SyntaxKind.ImportKeyword) dependency(node.arguments[0].text);
        else if (ts.isIdentifier(node.expression) && node.expression.text === 'require') dependency(node.arguments[0].text, true);
      }
      if (ts.isNewExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === 'URL' && node.arguments?.length && ts.isStringLiteral(node.arguments[0]))
        dependency(node.arguments[0].text, false, true);
      ts.forEachChild(node, scan);
    };
    scan(source);
  };
  visit(metadata.main);
  return { main: metadata.main, files: [...visited].sort(), boundary: 'literal module and URL dependencies; dynamic Gateway resources have separate inventories' };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (process.argv.length !== 3) throw Error('An explicit packaged app.asar is required');
  console.log(JSON.stringify(verifyDesktopEntryClosure(resolve(process.argv[2]))));
}
