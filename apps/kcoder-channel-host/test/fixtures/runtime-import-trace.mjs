// Child process: load every runtime module graph of one channel-host tree and
// print every file Node resolved, through both import and require.
// Usage: node runtime-import-trace.mjs <packageRoot>
import { registerHooks } from 'node:module';
import { readdir, readFile } from 'node:fs/promises';
import { join, relative, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = process.argv[2];
const resolved = new Set();
const viaParent = 'kcoder-trace-from:';
registerHooks({
  resolve(specifier, context, next) {
    // Resolve a specifier as the named parent module would at runtime.
    if (specifier.startsWith(viaParent)) {
      const { parent, target } = JSON.parse(decodeURIComponent(specifier.slice(viaParent.length)));
      specifier = target; context = { ...context, parentURL: parent };
    }
    const result = next(specifier, context);
    if (result.url?.startsWith('file:')) resolved.add(fileURLToPath(result.url));
    return result;
  },
});
// Process entry points run a service when evaluated. Load what they import,
// not the entry bodies themselves.
const entryPoints = new Set(['src/applications/stdio.mjs', 'src/channels/worker.mjs', 'src/channels/cli.mjs',
  'src/adapters/qq-registration-worker.mjs']);
const modules = [], entries = [];
async function visit(directory) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const full = join(directory, entry.name);
    if (entry.isDirectory()) await visit(full);
    else if (entry.name.endsWith('.mjs')) (entryPoints.has(relative(root, full).split(sep).join('/')) ? entries : modules).push(full);
  }
}
await visit(join(root, 'src'));
const specifiers = [];
for (const file of [...modules, ...entries]) {
  const text = await readFile(file, 'utf8');
  // SDKs are imported lazily inside adapters; load each such package too.
  for (const match of text.matchAll(/import\(\s*['"]([^'"]+)['"]\s*\)/g)) specifiers.push([file, match[1]]);
  if (entries.includes(file))
    for (const match of text.matchAll(/\bfrom\s*['"]([^'"]+)['"]/g)) specifiers.push([file, match[1]]);
}
const failures = [];
const load = async (parent, specifier) => {
  try {
    await import(viaParent + encodeURIComponent(JSON.stringify({ parent: pathToFileURL(parent).href, target: specifier })));
  } catch (error) {
    if (['ERR_MODULE_NOT_FOUND', 'MODULE_NOT_FOUND', 'ERR_PACKAGE_PATH_NOT_EXPORTED'].includes(error?.code))
      failures.push({ parent: relative(root, parent), specifier, code: error.code, message: String(error.message).slice(0, 300) });
  }
};
// Node runs each entry point file itself as a process root.
for (const file of entries) resolved.add(file);
for (const file of modules) await load(file, pathToFileURL(file).href);
for (const [parent, specifier] of specifiers) if (!specifier.startsWith('node:')) await load(parent, specifier);
const files = [...resolved].filter(file => file.startsWith(root + sep)).map(file => relative(root, file).split(sep).join('/')).sort();
process.stdout.write(JSON.stringify({ files, failures }) + '\n');
process.exit(0);
