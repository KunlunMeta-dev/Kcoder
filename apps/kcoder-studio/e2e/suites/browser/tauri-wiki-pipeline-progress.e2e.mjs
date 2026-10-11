import assert from 'node:assert/strict';
import { readFile, writeFile, copyFile, mkdir, chmod } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { startApprovalModelFixture } from '../../harness/approval-model.mjs';
import { startOwnedAiVerify } from '../../harness/ai-verify-client.mjs';
import { assertRendererBuildFresh } from '../../harness/renderer-build.mjs';
import { appRoot, repoRoot, runE2E, waitFor } from '../../harness/run-context.mjs';

await assertRendererBuildFresh();
if (!process.env.KCODER_E2E_TAURI_BIN) throw new Error('UNMET_PREREQUISITE: explicit owned Tauri binary required');
/** QA: owned native Studio + Gateway + Engine + fixed Provider SSE/HTTP faults.
 * Assert public stage records, pause/resume, source-specific labels and independent modes.
 * No response-quality assertion: model replies remain gated; outage is a protocol fixture.
 * Every profile, file, socket and subprocess belongs to RunContext and is cleaned on exit.
 */
await runE2E(import.meta.url, {
  testId: 'native-wiki-recorded-pipeline-and-recovery', tier: 'full-integration',
  modelPolicy: 'model-independent native Wiki stage/RPC/state presentation; fixed Provider transport only',
  retainSuccessLogs: true,
}, async context => {
  const marker = 'PIPELINE_UI_SOURCE_ONLY';
  let imageResponseReady = false;
  const isImage = body => (body.messages ?? []).some(message => Array.isArray(message.content) && message.content.some(item => item.type === 'image_url'));
  const options = { usage: { prompt_tokens: 12, completion_tokens: 7, total_tokens: 19 },
    responseSteps: ({ body }) => [{ ready: () => isImage(body) && imageResponseReady,
    delta: { role: 'assistant', content: isImage(body) ? 'PRIVATE_IMAGE_INTERPRETATION' : '{}' }, finishReason: 'stop' }],
    httpErrorStatus: 500, httpErrorMessage: 'Owned protocol test outage' };
  const fixture = await startApprovalModelFixture(context, options);
  const ownedKcoder = context.pathInState('bin', 'kcoder');
  await mkdir(dirname(ownedKcoder), { recursive: true, mode: 0o700 });
  await copyFile(process.env.KCODER_E2E_KCODER_BIN || resolve(repoRoot, 'target/debug/kcoder'), ownedKcoder);
  await chmod(ownedKcoder, 0o700);
  const client = await startOwnedAiVerify(context, {
    tauriBin: process.env.KCODER_E2E_TAURI_BIN,
    kcoderBin: ownedKcoder,
    rendererRoot: process.env.KCODER_E2E_RENDERER_ROOT || resolve(appRoot, 'renderer/dist'),
  });
  const command = (action, id, args = {}) => client.command(action, { selector: `[data-testid="${id}"]`, ...args });
  const stage = (name, state) => client.command('waitFor', {
    selector: `[data-testid="wiki-pipeline-step-${name}"][data-state="${state}"]`, timeoutMs: 30000,
  });
  const checked = id => command('getAttribute', id, { value: 'aria-checked' });
  try {
    const settings = JSON.parse(await readFile(client.settingsPath, 'utf8'));
    await writeFile(client.settingsPath, JSON.stringify({ ...settings, active_provider: 'pipeline-ui',
      providers: { 'pipeline-ui': { api_format: 'openai_chat_completions', authentication: { mode: 'none' },
        endpoint: fixture.baseUrl, default_model: 'pipeline-ui', context_window_tokens: 128000,
        max_output_tokens: 8192, output_headroom_tokens: 8192, no_proxy: true,
        models: { 'pipeline-ui': { context_window_tokens: 128000, max_output_tokens: 8192, output_headroom_tokens: 8192, capabilities: { vision: true } } } } } }), { mode: 0o600 });
    await command('waitFor', 'knowledge-button');
    await client.command('resizeWindow', { value: '1280x720' });
    await command('click', 'knowledge-button');
    await command('waitFor', 'knowledge-enable', { enabled: true });
    await command('click', 'knowledge-enable');
    await command('waitFor', 'knowledge-create', { enabled: true });
    await command('click', 'knowledge-create');
    await command('fill', 'wiki-create-input', { value: 'Owned pipeline progress' });
    await command('click', 'wiki-create-confirm');
    await command('waitFor', 'knowledge-library-picker', { text: 'Owned pipeline progress' });
    await command('fill', 'wiki-import-files', { value: JSON.stringify([
      { name: 'pipeline-source.md', text: `${marker}\nSynthetic protocol A is supported in the owned fixture.` },
    ]) });
    await stage('analyze', 'running');
    await stage('read', 'completed');
    assert.equal(await client.command('getElementCount', { selector: '[data-testid="wiki-pipeline-progress"] > li' }), '5');
    assert.ok(!(await command('getText', 'wiki-job-status')).includes('%'), 'unknown denominator never becomes a percentage');
    await client.capture('wiki-pipeline-running.png');
    await command('click', 'wiki-job-details');
    await command('waitFor', 'wiki-pipeline-details');
    assert.equal(await command('getAttribute', 'wiki-job-diagnostics', { value: 'open' }), '');
    await command('press', 'wiki-job-details-dialog', { key: 'Escape' });
    await command('click', 'wiki-job-control');
    await stage('analyze', 'paused');
    assert.match(await command('getText', 'wiki-job-control'), /从分析原文继续|Continue from Analyze source/);
    const jobRow = await client.command('getAttribute', { selector: '[data-testid^="wiki-job-row-"]', value: 'data-testid' });
    await command('click', 'knowledge-organization-enabled');
    await waitFor(async () => await checked('knowledge-organization-enabled') === 'false', 5000, 'organization independently off');
    assert.equal(await checked('knowledge-retrieval-enabled'), 'true');
    await command('waitFor', 'wiki-search');
    assert.equal(await command('getAttribute', 'wiki-job-control', { value: 'disabled' }), '');
    await command('click', 'knowledge-organization-enabled');
    await command('waitFor', 'wiki-job-control', { enabled: true });

    options.httpErrorPrompt = marker;
    await command('click', 'wiki-job-control');
    await stage('analyze', 'failed');
    assert.match(await command('getText', 'wiki-job-control'), /从分析原文继续|Continue from Analyze source/);
    assert.equal(await client.command('getElementCount', { selector: '[data-testid^="wiki-job-row-"]' }), '1');
    await command('click', 'knowledge-tab-sources');
    await client.command('waitFor', { selector: '[data-testid^="wiki-source-job-"][data-state="failed"]' });
    await client.capture('wiki-pipeline-source-failed.png');
    // Reproduce the persisted pre-fix state in this owned database only. It has
    // no proposal to approve; the live backend/UI must offer same-job recovery.
    const database = new DatabaseSync(resolve(dirname(client.settingsPath), 'knowledge/state.sqlite'));
    try {
      database.exec('PRAGMA busy_timeout=5000');
      const changed = database.prepare("UPDATE knowledge_jobs SET status='awaiting_review', checkpoint_json=NULL, error_code='review_required' WHERE job_id=? AND status='failed'")
        .run(jobRow.slice('wiki-job-row-'.length));
      assert.equal(changed.changes, 1);
    } finally { database.close(); }
    // The page is idle, but a changed authoritative job must be discovered
    // without navigation, manual refresh, or starting another model request.
    await waitFor(async () => /尚未生成可审核的完整建议|No complete suggestion is ready for review/.test(await command('getText', jobRow)), 20000, 'idle Wiki discovers changed authority and explains recovery');
    assert.equal(await client.command('getElementCount', { selector: '[data-testid="wiki-review-open"]' }), '0');
    await command('waitFor', 'wiki-job-control', { enabled: true });
    await client.capture('wiki-legacy-missing-candidate.png');
    const priorRequests = fixture.requests.length;
    options.httpErrorPrompt = undefined;
    await command('click', 'wiki-job-control');
    await stage('analyze', 'running');
    await waitFor(() => fixture.requests.length > priorRequests, 10000, 'failed source analysis resumes through Provider');
    assert.equal(await client.command('getAttribute', { selector: '[data-testid^="wiki-job-row-"]', value: 'data-testid' }), jobRow);
    await command('waitFor', 'wiki-job-control', { enabled: true });
    await command('click', 'wiki-job-control');
    await stage('analyze', 'paused');
    assert.ok(fixture.requests.length <= 12, 'bounded protocol fixture request count');
    // Image-stage assertions concern durability/transport, never the interpretation's quality.
    await command('click', 'knowledge-tab-pages');
    const png = 'iVBORw0KGgoAAAANSUhEUgAAACAAAAAgCAIAAAD8GO2jAAAAKElEQVR4nO3NsQ0AAAzCMP5/un0CNkuZ41wybXsHAAAAAAAAAAAAxR4yw/wuPL6QkAAAAABJRU5ErkJggg==';
    const imageDb = new DatabaseSync(resolve(dirname(client.settingsPath), 'knowledge/state.sqlite'));
    let imageId;
    try {
      imageDb.exec("PRAGMA busy_timeout=5000; CREATE TRIGGER owned_image_commit_fault BEFORE INSERT ON knowledge_sources WHEN NEW.title='owned-image.png' BEGIN SELECT RAISE(ABORT,'owned commit fault'); END;");
      await command('fill', 'wiki-import-files', { value: JSON.stringify([{ name: 'owned-image.png', contentBase64: png }]) });
      imageId = await waitFor(() => imageDb.prepare("SELECT id FROM knowledge_image_imports WHERE title='owned-image.png'").get()?.id, 10000, 'original accepted before vision completion');
      assert.equal(imageDb.prepare("SELECT COUNT(*) AS count FROM knowledge_sources WHERE title='owned-image.png'").get().count, 0);
      await client.command('waitFor', { selector: `[data-testid="wiki-image-import-${imageId}"][data-state="running"]`, timeoutMs: 20000 });
      imageResponseReady = true;
      await client.command('waitFor', { selector: `[data-testid="wiki-image-import-${imageId}"][data-state="failed"]`, timeoutMs: 20000 });
      const receipt = imageDb.prepare('SELECT response_hash,phase,status FROM knowledge_image_imports WHERE id=?').get(imageId);
      assert.ok(receipt.response_hash); assert.equal(receipt.phase, 'commit');
      assert.equal(imageDb.prepare("SELECT COUNT(*) AS count FROM knowledge_sources WHERE title='owned-image.png'").get().count, 0);
      const row = `[data-testid="wiki-image-import-${imageId}"]`;
      await client.command('click', { selector: `${row} > summary` });
      assert.match(await client.command('getText', { selector: `${row} [data-testid="wiki-image-import-usage"]` }), /12.*7/);
      assert.ok(!(await client.command('getText', { selector: row })).includes('PRIVATE_IMAGE_INTERPRETATION'));
      imageDb.exec('DROP TRIGGER owned_image_commit_fault');
      const priorImageCalls = fixture.requests.filter(isImage).length;
      await client.command('click', { selector: `${row} [data-testid="wiki-image-import-resume"]` });
      await client.command('waitFor', { selector: `${row}[data-state="completed"]`, timeoutMs: 20000 });
      assert.equal(fixture.requests.filter(isImage).length, priorImageCalls);
      assert.equal(imageDb.prepare("SELECT COUNT(*) AS count FROM knowledge_sources WHERE title='owned-image.png'").get().count, 1);
      assert.equal(imageDb.prepare('SELECT COUNT(*) AS count FROM knowledge_image_import_calls WHERE import_id=?').get(imageId).count, 1);
      await client.capture('wiki-image-cached-response-recovery.png');
      // Retrying the failed browser batch reuploads bytes with the same digest and replays the saved source.
      await client.command('click', { selector: '[data-testid="wiki-batch-retry"]' });
      await command('waitFor', 'wiki-file-import', { enabled: true });
      assert.equal(imageDb.prepare("SELECT COUNT(*) AS count FROM knowledge_image_imports WHERE title='owned-image.png'").get().count, 1);
      assert.equal(imageDb.prepare("SELECT COUNT(*) AS count FROM knowledge_sources WHERE title='owned-image.png'").get().count, 1);
      assert.equal(fixture.requests.filter(isImage).length, priorImageCalls);
      const beforeReplacement = imageDb.prepare("SELECT source_id,revision_id FROM knowledge_sources WHERE title='owned-image.png'").get();
      await command('click', 'knowledge-tab-sources');
      await command('click', `wiki-source-row-${beforeReplacement.source_id}`);
      await command('waitFor', 'wiki-original-reader');
      await client.command('fill', { selector: '[data-testid="wiki-original-reader"] input[type="file"]', value: JSON.stringify([{ name: 'owned-replacement.png', contentBase64: png }]) });
      const replacement = await waitFor(() => imageDb.prepare("SELECT source_id,revision_id FROM knowledge_sources WHERE title='owned-replacement.png'").get(), 10000, 'native replacement commits exact revision CAS');
      assert.equal(replacement.source_id, beforeReplacement.source_id);
      assert.notEqual(replacement.revision_id, beforeReplacement.revision_id);
      await command('press', 'wiki-original-reader', { key: 'Escape' });
      await command('click', 'knowledge-tab-pages');
      imageResponseReady = false;
      await command('waitFor', 'wiki-file-import', { enabled: true });
      await command('fill', 'wiki-import-files', { value: JSON.stringify([{ name: 'owned-cancel.png', contentBase64: png }]) });
      const cancelId = await waitFor(() => imageDb.prepare("SELECT id FROM knowledge_image_imports WHERE title='owned-cancel.png'").get()?.id, 10000, 'second durable image accepted');
      const cancelRow = `[data-testid="wiki-image-import-${cancelId}"]`;
      await client.command('waitFor', { selector: `${cancelRow}[data-state="running"]`, timeoutMs: 20000 });
      await client.command('click', { selector: `${cancelRow} > summary` });
      await client.command('click', { selector: `${cancelRow} [data-testid="wiki-image-import-cancel"]` });
      await client.command('waitFor', { selector: `${cancelRow}[data-state="cancelled"]`, timeoutMs: 10000 });
      await waitFor(() => fixture.requestOutcomes.filter(outcome => outcome.aborted).length > 0, 5000, 'cancel drops pending Provider stream');
      assert.equal(imageDb.prepare("SELECT COUNT(*) AS count FROM knowledge_sources WHERE title='owned-cancel.png'").get().count, 0);
      assert.equal(imageDb.prepare('SELECT COUNT(*) AS count FROM knowledge_image_import_calls WHERE import_id=? AND input_tokens IS NULL').get(cancelId).count, 1);
    } finally { imageDb.close(); }
    assert.ok(fixture.requests.length <= 16, 'bounded native/image protocol fixture request count');
    return { nativeStageRecords: true, compactFiveStages: true, unknownTotalsHonest: true,
      idleAuthorityRefresh: true, legacyMissingCandidateRecovery: true, pauseAndResumePreservedJob: true, failureLocalizedToSource: true, independentModes: true,
      providerRequests: fixture.requests.length, imageResponseResumeWithoutProvider: true, imageCancelAndUnknownUsage: true, imageReplacementKeepsSourceIdAndRevisionCas: true };
  } catch (error) {
    client.markFailed();
    const steps = {};
    for (const name of ['read', 'analyze', 'organize', 'check', 'save']) {
      steps[name] = await command('getAttribute', `wiki-pipeline-step-${name}`, { value: 'data-state' }).catch(() => 'unavailable');
    }
    await context.writeArtifactJson('failure-ui.json', {
      steps, summary: await command('getText', 'wiki-job-status').catch(() => 'unavailable'),
    });
    await client.capture('failure.png').catch(() => {});
    throw error;
  } finally {
    assert.equal((await client.stop()).cleaned, true);
  }
});
