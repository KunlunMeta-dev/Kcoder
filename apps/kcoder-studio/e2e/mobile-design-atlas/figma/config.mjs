import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { parseEnv } from 'node:util';

const SETTINGS = [
  'KCODER_FIGMA_PROJECT', 'KCODER_FIGMA_PROJECTS_FILE', 'KCODER_FIGMA_FILE_URL',
  'KCODER_FIGMA_CHECKPOINT', 'KCODER_FIGMA_INDEX', 'KCODER_FIGMA_MCP_SERVER', 'KCODER_FIGMA_CODEX_BIN',
];
const SCOPED = ['KCODER_FIGMA_FILE_URL', 'KCODER_FIGMA_CHECKPOINT', 'KCODER_FIGMA_INDEX'];

export function parseFigmaTarget(value) {
  let url;
  try { url = new URL(value); } catch { throw new Error('Invalid Figma target URL'); }
  assert.ok(url.protocol === 'https:' && ['figma.com', 'www.figma.com'].includes(url.hostname)
    && !url.username && !url.password && !url.port, 'Expected an HTTPS Figma Design URL');
  const parts = url.pathname.split('/').filter(Boolean);
  const branch = parts.indexOf('branch');
  const fileKey = branch >= 2 ? parts[branch + 1] : parts[1];
  assert.ok(parts[0] === 'design' && /^[a-zA-Z0-9]+$/.test(fileKey || ''), 'Expected a Figma Design file');
  const rawNode = url.searchParams.get('node-id');
  assert.ok(!rawNode || /^\d+[:-]\d+$/.test(rawNode), 'Invalid Figma target node ID');
  const rootNodeId = rawNode?.replace('-', ':') || null;
  // Sharing/tracking parameters are not connection configuration or credentials.
  url.search = ''; url.hash = '';
  if (rootNodeId) url.searchParams.set('node-id', rootNodeId.replace(':', '-'));
  return { fileKey, rootNodeId, url: url.href };
}

/** Read only non-secret Figma settings. Never source shell or mutate process.env. */
export async function loadFigmaConfiguration(root, source = process.env, { project } = {}) {
  let repository = {};
  try {
    const text = await readFile(resolve(root, '.env'), 'utf8');
    try { repository = parseEnv(text); } catch { throw new Error('Unable to parse repository Figma environment settings'); }
  } catch (error) { if (error.code !== 'ENOENT') throw error; }
  const environment = {};
  for (const key of SETTINGS) {
    const value = source[key] ?? repository[key];
    if (value !== undefined && value !== '') environment[key] = value;
  }
  const projectsPath = environment.KCODER_FIGMA_PROJECTS_FILE
    ? resolve(root, environment.KCODER_FIGMA_PROJECTS_FILE) : new URL('./projects.json', import.meta.url);
  const registry = JSON.parse(await readFile(projectsPath, 'utf8'));
  assert.ok(registry.schema === 1 && registry.projects, 'Unsupported Figma project registry');
  const selected = project || environment.KCODER_FIGMA_PROJECT || registry.defaultProject;
  assert.ok(/^[a-zA-Z0-9_-]+$/.test(selected || '') && Object.hasOwn(registry.projects, selected),
    'Unknown Figma project; use --projects to list configured projects');
  const profile = registry.projects[selected];
  const registered = parseFigmaTarget(profile.url);
  const sameTarget = (a, b) => a.fileKey === b.fileKey && a.rootNodeId === b.rootNodeId;
  // A CLI/process profile switch must not inherit another profile's dotenv paths.
  const repositoryProject = repository.KCODER_FIGMA_PROJECT || registry.defaultProject;
  let useRepositoryTarget = selected === repositoryProject;
  if (useRepositoryTarget && repository.KCODER_FIGMA_FILE_URL) {
    const repositoryTarget = parseFigmaTarget(repository.KCODER_FIGMA_FILE_URL);
    if (!sameTarget(repositoryTarget, registered) && Object.values(registry.projects)
      .some(entry => sameTarget(parseFigmaTarget(entry.url), repositoryTarget))) useRepositoryTarget = false;
  }
  for (const key of SCOPED) {
    delete environment[key];
    const value = source[key] ?? (useRepositoryTarget ? repository[key] : undefined);
    if (value !== undefined && value !== '') environment[key] = value;
  }
  const target = parseFigmaTarget(environment.KCODER_FIGMA_FILE_URL || profile.url);
  assert.equal(target.fileKey, registered.fileKey, 'Figma URL differs from selected profile; register/select a separate project');
  if (registered.rootNodeId) assert.equal(target.rootNodeId, registered.rootNodeId, 'Figma REF region differs from selected profile');
  assert.ok(profile.checkpoint && profile.index, 'Each Figma profile needs its own checkpoint and index paths');
  const checkpointPath = resolve(root, environment.KCODER_FIGMA_CHECKPOINT || profile.checkpoint);
  const indexPath = resolve(root, environment.KCODER_FIGMA_INDEX || profile.index);
  assert.notEqual(checkpointPath, indexPath, 'Checkpoint and index must be separate files');
  return { project: selected, ...target, checkpointPath, indexPath, environment: {
    ...environment, KCODER_FIGMA_PROJECT: selected, KCODER_FIGMA_FILE_URL: target.url,
    KCODER_FIGMA_CHECKPOINT: checkpointPath, KCODER_FIGMA_INDEX: indexPath,
  }, projects: Object.entries(registry.projects).map(([name, entry]) => ({ name, ...parseFigmaTarget(entry.url) })) };
}

export function validateFigmaIdentity(configuration, checkpoint, index) {
  assert.equal(checkpoint.fileKey, configuration.fileKey, 'Checkpoint belongs to another Figma file');
  if (configuration.rootNodeId) assert.equal(checkpoint.rootNodeId, configuration.rootNodeId, 'Checkpoint belongs to another REF region');
  assert.ok(checkpoint.schema === 1 && checkpoint.pageNodeId && checkpoint.states?.length && Array.isArray(checkpoint.routes),
    'Register the project REF anchors and routes before syncing');
  if (index) {
    assert.equal(index.fileKey, checkpoint.fileKey, 'Reference index belongs to another Figma file');
    assert.equal(index.rootNodeId, checkpoint.rootNodeId, 'Reference index belongs to another REF region');
  }
}

export async function readFigmaTarget(configuration) {
  let checkpoint, index;
  try {
    checkpoint = JSON.parse(await readFile(configuration.checkpointPath, 'utf8'));
    index = JSON.parse(await readFile(configuration.indexPath, 'utf8'));
  } catch (error) {
    if (error.code === 'ENOENT') throw new Error('Figma project checkpoint/index missing; register its REF anchors before syncing');
    throw error;
  }
  validateFigmaIdentity(configuration, checkpoint, index);
  return { checkpoint, index };
}
