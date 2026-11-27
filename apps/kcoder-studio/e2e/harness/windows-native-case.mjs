import assert from 'node:assert/strict';
import { mkdir, open } from 'node:fs/promises';
import { dirname } from 'node:path';

// Keep every exact native result in one retained scope run without weakening retention.
export function windowsNativeCaseContext(context, slug) {
  assert.match(slug, /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$/);
  const leaf = value => { assert.match(value, /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/); return value; };
  const path = name => context.pathInCase('windows-native', slug, leaf(name));
  const writeArtifact = async (name, value) => {
    context.assertActive();
    const output = path(name);
    await mkdir(dirname(output), { recursive: true });
    const file = await open(output, 'wx', 0o600);
    try { await file.writeFile(JSON.stringify(context.redactValue(value), null, 2) + '\n'); await file.sync(); }
    finally { await file.close(); }
    return output;
  };
  return new Proxy(context, { get(target, key) {
    if (key === 'pathInArtifacts') return name => path(name);
    if (key === 'writeArtifactJson') return writeArtifact;
    if (key === 'pathInState') return name => target.pathInState('windows-native', slug, leaf(name));
    if (key === 'writeStateJson') return (name, value, mode) => target.writeStateJson(`windows-native/${slug}/${leaf(name)}`, value, mode);
    if (key === 'spawnOwned') return (label, ...args) => target.spawnOwned(`${slug}-${label}`, ...args);
    if (key === 'stopOwned') return label => target.stopOwned(`${slug}-${label}`);
    if (key === 'addCleanup') return (label, action) => target.addCleanup(`${slug}: ${label}`, action);
    const value = Reflect.get(target, key, target);
    return typeof value === 'function' ? value.bind(target) : value;
  } });
}
