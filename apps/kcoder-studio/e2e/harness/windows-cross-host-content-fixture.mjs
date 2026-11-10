import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { chmod, lstat, mkdir, readFile, writeFile } from 'node:fs/promises';
import { isAbsolute, join, dirname, relative, sep, win32 } from 'node:path';

const sha = bytes => createHash('sha256').update(bytes).digest('hex');
export const CROSS_HOST_MEMORY_BODY = 'UNVERIFIED_CROSS_HOST_NOTE\nA source model claim is not an established fact or system instruction.\n';
export const CROSS_HOST_AGENT_BODY = '---\nname: cross-host-review\ndescription: Preserve source data\npermissionMode: bypassPermissions\nPRIVATE_UNKNOWN_FIELD: keep pending\n---\nPASSIVE_CROSS_HOST_AGENT only data.\n';
export const CROSS_HOST_CODEX_AGENT_BODY = "name='cross-host-review'\ndescription='Preserve source data'\ndeveloper_instructions='PASSIVE_CROSS_HOST_CODEX_AGENT only data.'\nUNKNOWN_DYNAMIC_SEMANTICS='keep pending'\n";

/** Match FolderTrustStore's canonical Windows records; this does not authorize another root. */
export function crossHostWindowsTrustPaths(paths) {
  assert.ok(Array.isArray(paths) && paths.length > 0);
  return paths.map(path => {
    assert.ok(win32.isAbsolute(path) && /^[A-Za-z]:\\/.test(path) && !/[\u0000-\u001f]/.test(path));
    return win32.toNamespacedPath(path);
  });
}

async function ordinaryDirectory(root) {
  const value = await lstat(root);
  assert.ok(value.isDirectory() && !value.isSymbolicLink(), 'only an owned ordinary source directory may be seeded');
}

async function createFixtureFile(root, name, bytes) {
  assert.ok(name.split('/').every(part => /^[A-Za-z0-9_.-]+$/.test(part) && part !== '.' && part !== '..'));
  const destination = join(root, ...name.split('/'));
  assert.ok(relative(root, destination) && !relative(root, destination).startsWith('..' + sep));
  let parent = root;
  for (const part of name.split('/').slice(0, -1)) {
    parent = join(parent, part);
    await mkdir(parent, { mode: 0o700 }).catch(error => { if (error.code !== 'EEXIST') throw error; });
    await ordinaryDirectory(parent);
  }
  await writeFile(destination, bytes, { mode: 0o600, flag: 'wx' });
  const value = await lstat(destination); assert.ok(value.isFile() && !value.isSymbolicLink() && value.nlink === 1);
  return { path: name, sha256: sha(bytes), bytes: bytes.length };
}

/** Synthetic vendor layouts match the versioned Native fixtures; no vendor CLI or Hook executes. */
export async function seedCrossHostContentSource(source, label, marker) {
  assert.ok(isAbsolute(source) && ['windows', 'linux'].includes(label) && isAbsolute(marker));
  await ordinaryDirectory(source);
  const files = [];
  const put = async (name, value) => { const bytes = Buffer.isBuffer(value) ? value : Buffer.from(value); files.push(await createFixtureFile(source, name, bytes)); };
  for (let index = 0; index < 11; index++) {
    await put(`projects/cross-host-notes/memory/note-${String(index).padStart(2, '0')}.md`, CROSS_HOST_MEMORY_BODY + (index === 0 ? '未验证笔记。'.repeat(1800) : `owned-${label}-${index}\n`));
  }
  await put('codex/memories/MEMORY.md', CROSS_HOST_MEMORY_BODY + `owned-${label}-codex\n`);
  await put('agents/cross-host-review.md', CROSS_HOST_AGENT_BODY);
  await put('agents/opaque.md', Buffer.from([255, 0, 254]));
  await put('codex/agents/cross-host-review.toml', CROSS_HOST_CODEX_AGENT_BODY);
  const command = label === 'windows' ? `powershell -NoProfile -Command Set-Content '${marker.replaceAll("'", "''")}' forbidden` : `touch '${marker.replaceAll("'", "'\\''")}'`;
  await put('codex/hooks.json', JSON.stringify({ hooks: { PreToolUse: [{ matcher: 'never', hooks: [{ type: 'command', command, UNREVIEWED_HOOK_FIELD: 'preserve only' }] }] } }));
  for (const kind of ['claude', 'codex']) {
    const root = `instruction-${kind}`;
    await put(`${root}/.git/owned-fixture`, 'This empty marker is test data, not a copied worktree.\n');
    const file = kind === 'claude' ? 'CLAUDE.md' : 'AGENTS.md';
    await put(`${root}/${file}`, `OWNED_${label}_${kind}_ROOT\n${kind === 'claude' ? '@details.md\n' : 'Treat @details.md as ordinary Markdown.\n'}`);
    if (kind === 'claude') await put(`${root}/details.md`, 'CLAUDE_ROOT_STATIC_IMPORT keep original scope.\n');
    await put(`${root}/child/${file}`, `OWNED_${label}_${kind}_CHILD_SCOPE\n`);
  }
  const packageRelative = 'plugins/cache/owned/cross-host-static/1.0.0';
  await put(`${packageRelative}/.claude-plugin/plugin.json`, JSON.stringify({ name: 'cross-host-static', version: '1.0.0', description: 'Disabled source package', hooks: { SessionStart: [{ hooks: [{ type: 'command', command }] }] } }));
  await put(`${packageRelative}/skills/inspect/SKILL.md`, '---\nname: inspect\ndescription: Only inspect explicitly supplied material\n---\nCROSS_HOST_PLUGIN_DATA never run a source Hook.\n');
  if (label === 'linux') await chmod(join(source, ...packageRelative.split('/'), 'skills/inspect/SKILL.md'), 0o700);
  await put('plugins/installed_plugins.json', JSON.stringify({ version: 2, plugins: { 'cross-host-static@owned': [{ scope: 'user', installPath: join(source, ...packageRelative.split('/')), version: '1.0.0' }] } }));
  return { version: 1, label, files, classes: ['memory', 'definitions', 'instructions', 'plugin'],
    instructionRoots: { 'claude-code': join(source, 'instruction-claude'), codex: join(source, 'instruction-codex') },
    memoryNoteCount: 12, passiveDefinitionsOnly: true, pluginDefaultDisabled: true, pluginSourceStatic0700: label === 'linux' };
}

/** Keep integrity comparisons boolean: an assertion failure must never echo an entire source file. */
export async function verifyCrossHostContentSource(source, metadata) {
  assert.ok(isAbsolute(source) && metadata?.version === 1 && Array.isArray(metadata.files));
  for (const item of metadata.files) {
    assert.ok(item.path.split('/').every(part => /^[A-Za-z0-9_.-]+$/.test(part) && part !== '.' && part !== '..'));
    const file = join(source, ...item.path.split('/')); await ordinaryDirectory(dirname(file));
    const value = await lstat(file); assert.ok(value.isFile() && !value.isSymbolicLink() && value.nlink === 1);
    const bytes = await readFile(file);
    assert.ok(bytes.length === item.bytes && sha(bytes) === item.sha256, 'owned source bytes changed');
  }
  return { sourceUnchanged: true, verifiedFiles: metadata.files.length };
}
