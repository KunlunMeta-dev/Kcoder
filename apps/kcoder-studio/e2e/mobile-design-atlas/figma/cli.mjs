import assert from 'node:assert/strict';
import { readFile, realpath } from 'node:fs/promises';
import { resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { createInterface } from 'node:readline';
import { runE2E, repoRoot, waitFor } from '../../harness/run-context.mjs';
import { connectFigmaSync } from './transport/codex.mjs';
import { acquireSyncLock, decodeSyncResult, synchronizeFigma } from './sync/job.mjs';
import { auditFigmaReference, updateReferenceIndex } from './canvas/audit.mjs';
import { loadFigmaConfiguration, readFigmaTarget, validateFigmaIdentity } from './config.mjs';
import { summarizeSync } from './report/summary.mjs';

const HELP = `node apps/kcoder-studio/e2e/mobile-design-atlas/figma-sync.mjs [--project name] [--check] [--bundle sync-bundle.json | --resume sync-journal.json]
--projects lists configured targets without connecting to Figma.
Default: read repository .env, export current source, preflight and apply through authenticated Figma MCP. No model turns.
Configuration: apps/kcoder-studio/e2e/mobile-design-atlas/figma/README.md`;

export function parseFigmaArguments(args) {
  const options = {};
  for (let i = 0; i < args.length; i++) {
    const name = args[i];
    assert.ok(['--bundle', '--resume', '--project', '--check', '--projects', '--help'].includes(name), 'Unknown Figma sync argument; use --help');
    const key = name.slice(2);
    assert.ok(!Object.hasOwn(options, key), `Duplicate ${name}`);
    if (['--bundle', '--resume', '--project'].includes(name)) {
      assert.ok(args[i + 1] && !args[i + 1].startsWith('--'), `Missing ${name} value`);
      options[key] = args[++i];
    } else options[key] = true;
  }
  assert.ok(!(options.bundle && options.resume), 'Choose --bundle or --resume');
  return options;
}

export async function runFigmaSync(sourceUrl, args = process.argv.slice(2)) {
  process.umask(0o077);
  const options = parseFigmaArguments(args);
  if (options.help) { console.log(HELP); return; }
  const configuration = await loadFigmaConfiguration(repoRoot, process.env, options);
  if (options.projects) {
    for (const target of configuration.projects) console.log(`${target.name === configuration.project ? '*' : ' '} ${target.name} ${target.url}`);
    return;
  }
  // Fail before connecting or building if a profile was pointed at another file.
  await readFigmaTarget(configuration);
  return runE2E(sourceUrl, { testId: 'figma-sync', tier: 'manual-live', retainSuccessLogs: true,
    modelPolicy: 'Authorized deterministic Figma REF synchronization through MCP; no model turn, provider request or Gateway session' }, async run => {
    const { checkpointPath, indexPath, environment } = configuration;
    const owner = { jobId: randomUUID(), pid: process.pid, runRoot: run.runRoot };
    const release = await acquireSyncLock(`${checkpointPath}.lock`, owner);
    run.addCleanup('release Figma sync lock', release);
    let journal = options.resume ? JSON.parse(await readFile(await realpath(options.resume), 'utf8')) : null;
    let bundlePath = options.resume ? journal.bundlePath : options.bundle;
    const mcp = await connectFigmaSync(run, { server: environment.KCODER_FIGMA_MCP_SERVER, command: environment.KCODER_FIGMA_CODEX_BIN });
    console.log(`[Figma sync] project ${configuration.project}; authenticated MCP connected; model turns: 0`);
    if (!bundlePath) {
      let exported;
      const child = run.spawnOwned('current-source-export', process.execPath, [resolve(repoRoot, 'apps/kcoder-studio/e2e/mobile-design-atlas/figma-reference-export.mjs')], {
        cwd: repoRoot, env: { ...process.env, ...environment, KCODER_FIGMA_SYNC: '1' },
      });
      const lines = createInterface({ input: child.stdout });
      lines.on('line', line => {
        if (line.startsWith('FIGMA_SYNC_READY ')) exported = line.slice('FIGMA_SYNC_READY '.length);
        if (line.startsWith('[Figma reference]')) console.log(line);
      });
      await waitFor(() => child.exitCode !== null, 600000, 'current-source Figma export', 500);
      assert.equal(child.exitCode, 0, 'Export failed; no Figma writes were attempted. Inspect current-source-export.log');
      assert.ok(exported, 'Export did not return its owned package path');
      bundlePath = resolve(exported, 'sync-bundle.json');
    }
    bundlePath = await realpath(bundlePath);
    const bundle = JSON.parse(await readFile(bundlePath, 'utf8'));
    validateFigmaIdentity(configuration, bundle.checkpoint);
    const session = decodeSyncResult(await mcp.call('create_session', { fileKey: configuration.fileKey, description: 'One-command KCoder current-source REF sync' }));
    const journalPath = run.pathInArtifacts('sync-journal.json');
    journal ||= { schema: 1, jobId: owner.jobId, fileKey: configuration.fileKey, rootNodeId: bundle.checkpoint.rootNodeId,
      createdAt: new Date().toISOString(), completed: [], events: [] };
    journal.bundlePath = bundlePath;
    journal.project = configuration.project;
    console.log(`FIGMA_SYNC_JOURNAL ${journalPath}`);
    const before = await auditFigmaReference(mcp.call, session.sessionId, bundle.checkpoint, { includeEdges: false });
    await run.writeArtifactJson('canvas-before.json', before);
    const result = await synchronizeFigma({ bundle, call: mcp.call, sessionId: session.sessionId, checkpointPath, journalPath, journal, checkOnly: !!options.check,
      onProgress: p => console.log(p.phase === 'preview' ? `[Figma sync] preflight ${p.states.length} states` : `[Figma sync] ${p.done}/${p.total}: ${p.states.join(', ')}`) });
    const after = await auditFigmaReference(mcp.call, session.sessionId, result.checkpoint);
    await run.writeArtifactJson('canvas-after.json', after);
    assert.equal(after.originalAreaHash, before.originalAreaHash, 'Original designer area changed during sync; review concurrent edits');
    assert.deepEqual(after.flowStartingPoints, before.flowStartingPoints, 'Prototype starting points changed during sync; review concurrent edits');
    assert.equal(after.missing.length, 0, 'Prototype destinations missing');
    assert.equal(after.temporary.length, 0, 'Staging nodes remain');
    assert.equal(after.emptyFrames.length, 0, 'Empty REF frames');
    if (!options.check) await updateReferenceIndex(indexPath, result.checkpoint, after, bundle);
    const summary = summarizeSync({ result, bundle, bundlePath, configuration, checkOnly: !!options.check,
      currentSourceExported: !options.bundle && !options.resume });
    await run.writeArtifactJson('summary.json', summary);
    const { changedStates } = summary;
    console.log(`FIGMA_SYNC_DONE ${changedStates} changed states`);
    return { status: result.job.status, states: bundle.states.length, changed: changedStates, journalPath, modelTurns: 0 };
  });
}
