import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { runE2E } from '../../../harness/run-context.mjs';
import { loadFigmaConfiguration, parseFigmaTarget, readFigmaTarget, validateFigmaIdentity } from '../config.mjs';
import { parseFigmaArguments } from '../cli.mjs';
import { writeFigmaSyncPackage } from '../capture/package.mjs';

const owned = (name, body) => runE2E(import.meta.url, { testId: `figma-config-${name}`, tier: 'unit',
  modelPolicy: 'Offline synthetic project configuration and bundle packaging; no OAuth, Figma service or model' }, body);
async function fixture(run) {
  const root = run.pathInState('repository'); await mkdir(root);
  const checkpoint = fileKey => ({ schema: 1, fileKey, pageNodeId: '0:1', rootNodeId: '90:2',
    states: [{ stateId: 'A', nodeId: '1:2', hash: 'baseline' }], routes: [] });
  const projects = Object.fromEntries(['alpha', 'beta'].map(name => [name, {
    url: `https://www.figma.com/design/${name}/design?node-id=90-2`, checkpoint: `${name}.checkpoint.json`, index: `${name}.index.json`,
  }]));
  await writeFile(resolve(root, 'projects.json'), JSON.stringify({ schema: 1, defaultProject: 'alpha', projects }));
  for (const name of ['alpha', 'beta']) {
    await writeFile(resolve(root, projects[name].checkpoint), JSON.stringify(checkpoint(name)));
    await writeFile(resolve(root, projects[name].index), JSON.stringify({ fileKey: name, rootNodeId: '90:2' }));
  }
  await writeFile(resolve(root, '.env'), `KCODER_FIGMA_PROJECTS_FILE=projects.json\nKCODER_FIGMA_PROJECT=alpha\nKCODER_FIGMA_FILE_URL=${projects.alpha.url}\nKCODER_FIGMA_CHECKPOINT=alpha.checkpoint.json\nKCODER_FIGMA_INDEX=alpha.index.json\nKCODER_FIGMA_MCP_SERVER=figma-repository\nUNRELATED_SECRET=do-not-export\nKCODER_FIGMA_TOKEN=do-not-export-either\n`);
  return { root, projects };
}

test('dotenv loads only non-secret settings; process overrides it without global mutations', () => owned('defaults', async run => {
  const { root } = await fixture(run);
  const source = { KCODER_FIGMA_MCP_SERVER: 'figma-explicit', UNRELATED_SECRET: 'private' }, before = { ...source };
  const configuration = await loadFigmaConfiguration(root, source);
  assert.equal(configuration.project, 'alpha'); assert.equal(configuration.environment.KCODER_FIGMA_MCP_SERVER, 'figma-explicit');
  assert.equal(configuration.environment.UNRELATED_SECRET, undefined); assert.equal(configuration.environment.KCODER_FIGMA_TOKEN, undefined);
  assert.deepEqual(source, before); assert.ok(!JSON.stringify(configuration).includes('private'));
  await readFigmaTarget(configuration);
}));

test('CLI and process project switches cannot inherit another project dotenv URL or paths', () => owned('switch', async run => {
  const { root } = await fixture(run);
  for (const [source, options] of [[{}, { project: 'beta' }], [{ KCODER_FIGMA_PROJECT: 'beta' }, {}], [{ KCODER_FIGMA_PROJECT: 'alpha' }, { project: 'beta' }]]) {
    const selected = await loadFigmaConfiguration(root, source, options);
    assert.equal(selected.project, 'beta'); assert.equal(selected.fileKey, 'beta');
    assert.equal(selected.checkpointPath, resolve(root, 'beta.checkpoint.json')); assert.equal(selected.indexPath, resolve(root, 'beta.index.json'));
    assert.equal((await readFigmaTarget(selected)).checkpoint.fileKey, 'beta');
  }
  await assert.rejects(() => loadFigmaConfiguration(root, {}, { project: 'unknown' }), /Unknown Figma project/);
  await assert.rejects(() => loadFigmaConfiguration(root, { KCODER_FIGMA_FILE_URL: 'https://www.figma.com/design/beta/file?node-id=90-2' }), /differs from selected profile/);
  await assert.rejects(() => loadFigmaConfiguration(root, { KCODER_FIGMA_FILE_URL: 'https://www.figma.com/design/alpha/file?node-id=91-2' }), /REF region differs/);
  // Changing just the persistent profile also excludes the old known target.
  const dotenv = resolve(root, '.env');
  await writeFile(dotenv, (await readFile(dotenv, 'utf8')).replace('KCODER_FIGMA_PROJECT=alpha', 'KCODER_FIGMA_PROJECT=beta'));
  const persistent = await loadFigmaConfiguration(root, {});
  assert.equal(persistent.fileKey, 'beta');
  assert.equal((await readFigmaTarget(persistent)).checkpoint.fileKey, 'beta');
  await writeFile(dotenv, (await readFile(dotenv, 'utf8')).replace('design/alpha/', 'design/unregistered/'));
  await assert.rejects(() => loadFigmaConfiguration(root, {}), /differs from selected profile/);
}));

test('wrong or uninitialized checkpoint/index is rejected locally; registry and existing state stay unchanged', () => owned('identity', async run => {
  const { root } = await fixture(run), configuration = await loadFigmaConfiguration(root, {});
  const { checkpoint, index } = await readFigmaTarget(configuration), original = await readFile(configuration.checkpointPath, 'utf8');
  assert.throws(() => validateFigmaIdentity(configuration, { ...checkpoint, fileKey: 'beta' }), /another Figma file/);
  assert.throws(() => validateFigmaIdentity(configuration, { ...checkpoint, rootNodeId: '88:1' }), /another REF region/);
  assert.throws(() => validateFigmaIdentity(configuration, checkpoint, { ...index, fileKey: 'beta' }), /index belongs to another Figma file/);
  await assert.rejects(() => readFigmaTarget({ ...configuration, checkpointPath: resolve(root, 'missing.json') }), /register its REF anchors/);
  assert.equal(await readFile(configuration.checkpointPath, 'utf8'), original);
}));

test('split modules still package the actual builder, core and offline plugin, not import stubs', () => owned('package', async run => {
  const { root } = await fixture(run), configuration = await loadFigmaConfiguration(root, {});
  const scene = { key: 'dom-1', name: 'root', tag: 'div', box: { x: 0, y: 0, w: 390, h: 844 }, style: { opacity: '1', backgroundColor: 'transparent' }, children: [] };
  const output = await writeFigmaSyncPackage({ artifactsDir: run.artifactsDir, checkpointPath: configuration.checkpointPath,
    data: { sourceHash: 'snapshot', states: [{ id: 'A', title: 'Synthetic', scene: { root: scene } }] } });
  const code = await readFile(resolve(output.output, 'code.js'), 'utf8');
  assert.match(code, /async function buildEditableScreens/); assert.match(code, /async function applySync/);
  assert.match(code, /figma\.ui\.onmessage/); assert.doesNotMatch(code, /export \* from|import .* from/);
  assert.equal(JSON.parse(await readFile(resolve(output.output, 'sync-bundle.json'))).checkpoint.fileKey, 'alpha');
}));

test('Figma URLs are canonical and Design-only; CLI options are explicit', () => {
  assert.deepEqual(parseFigmaTarget('https://www.figma.com/design/abc/name?node-id=90-2&t=tracking#ignored'), {
    fileKey: 'abc', rootNodeId: '90:2', url: 'https://www.figma.com/design/abc/name?node-id=90-2',
  });
  assert.equal(parseFigmaTarget('https://www.figma.com/design/main/branch/branchkey/name?node-id=1-2').fileKey, 'branchkey');
  for (const url of ['https://figma.com.evil/design/key/name', 'http://www.figma.com/design/key/name', 'https://www.figma.com/board/key/name', 'https://user:secret@www.figma.com/design/key/name']) assert.throws(() => parseFigmaTarget(url));
  assert.deepEqual(parseFigmaArguments(['--project', 'beta', '--check']), { project: 'beta', check: true });
  for (const args of [['--project'], ['--bundle', 'a', '--resume', 'b'], ['--check', '--check'], ['--unknown']]) assert.throws(() => parseFigmaArguments(args));
});
