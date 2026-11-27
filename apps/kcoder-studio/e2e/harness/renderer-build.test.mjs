import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, utimes, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import test from 'node:test';
import { assertRendererBuildFresh } from './renderer-build.mjs';

test('test-only helpers do not stale a renderer but production and plugin edits do', async t => {
  const root = await mkdtemp(join(tmpdir(), 'kcoder-renderer-freshness-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, 'src'));
  await mkdir(join(root, 'plugins'));
  await mkdir(join(root, 'dist'));
  for (const [file, time] of [['src/app.ts', 1000], ['plugins/grouping.ts', 1000], ['dist/index.html', 2000], ['src/probe.test-support.tsx', 3000]]) {
    await writeFile(join(root, file), 'fixture');
    await utimes(join(root, file), time, time);
  }
  await assertRendererBuildFresh({ sourceRoot: root, buildRoot: join(root, 'dist') });
  await utimes(join(root, 'src/app.ts'), 4000, 4000);
  await assert.rejects(assertRendererBuildFresh({ sourceRoot: root, buildRoot: join(root, 'dist') }), /构建产物早于源码/);
  await utimes(join(root, 'src/app.ts'), 1000, 1000);
  await utimes(join(root, 'plugins/grouping.ts'), 4000, 4000);
  await assert.rejects(assertRendererBuildFresh({ sourceRoot: root, buildRoot: join(root, 'dist') }), /构建产物早于源码/);
});

test('workspace dependency launchers do not stale product assets; source and lockfile changes still do', async t => {
  const root = await mkdtemp(join(tmpdir(), 'kcoder-renderer-workspace-freshness-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  for (const directory of ['src', 'dist', 'packages/chat-core/src', 'packages/chat-core/node_modules/.bin'])
    await mkdir(join(root, directory), { recursive: true });
  for (const [file, time] of [
    ['src/app.ts', 1000], ['dist/index.html', 2000], ['packages/chat-core/src/index.ts', 1000],
    ['packages/chat-core/node_modules/.bin/vitest', 3000], ['pnpm-lock.yaml', 1000],
  ]) {
    await writeFile(join(root, file), 'fixture');
    await utimes(join(root, file), time, time);
  }
  await assertRendererBuildFresh({ sourceRoot: root, buildRoot: join(root, 'dist') });
  await utimes(join(root, 'packages/chat-core/src/index.ts'), 4000, 4000);
  await assert.rejects(assertRendererBuildFresh({ sourceRoot: root, buildRoot: join(root, 'dist') }), /构建产物早于源码/);
  await utimes(join(root, 'packages/chat-core/src/index.ts'), 1000, 1000);
  await utimes(join(root, 'pnpm-lock.yaml'), 4000, 4000);
  await assert.rejects(assertRendererBuildFresh({ sourceRoot: root, buildRoot: join(root, 'dist') }), /构建产物早于源码/);
});
