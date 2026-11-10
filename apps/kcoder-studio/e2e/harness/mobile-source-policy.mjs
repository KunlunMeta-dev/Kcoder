const excludedDirectories = new Set(['.expo', '.git', 'dist', 'node_modules']);
const publicSourceModules = new Set([
  'src/runtime/migration-client/credential-sources-contracts.ts',
  'src/runtime/migration-source/private-credential-controller.ts',
  'src/runtime/migration-source/private-credentials.ts',
  'generated/contracts.migration-source-credentials.ts',
  'generated/contracts.migration-credentials.ts',
  'generated/contractGuards.migration-source-credentials.mjs',
  'generated/contractGuards.migration-credentials.mjs',
]);

/** Exact public source modules are not credential data; similarly named data stays excluded. */
export function shouldOmitMobileSourceEntry(name, relativePath = name, isDirectory = false) {
  if (excludedDirectories.has(name)) return true;
  if (/^\.env(?:\..+)?$/i.test(name) && name.toLowerCase() !== '.env.example') return true;
  if (!isDirectory && publicSourceModules.has(relativePath) && relativePath.endsWith(`/${name}`)) return false;
  return /(?:^|[._-])(?:secret|secrets|credential|credentials)(?:[._-]|$)/i.test(name);
}
