import { beforeEach, expect, it, vi } from 'vitest';
const fake = vi.hoisted(() => ({ gate: false, allowed: true, requests: [] as Array<{ path: string; body: any }>, handler: null as any }));
vi.mock('@/storage/workspace-profile-fence', () => ({ captureWorkspaceProfileIdentity: (value: any) => value.id, startWorkspaceProfileRpc: async (_identity: string, send: () => Promise<unknown>) => { if (!fake.allowed) throw new Error('revoked'); fake.gate = true; try { return { response: send() }; } finally { fake.gate = false; } } }));
vi.mock('@/gateway/http', () => ({ gatewayRequest: async (_profile: unknown, path: string, init: RequestInit, limits: { beforeDispatch(): void }) => { await Promise.resolve(); limits.beforeDispatch(); expect(fake.gate).toBe(false); const body = JSON.parse(String(init.body)); fake.requests.push({ path, body }); return fake.handler(path, body); } }));
import { createMigrationSourceSessionClient } from './sessions';
import { MobileSourceCatalog } from './catalog';
import type { GatewayProfile } from '@/gateway/types';
import type { SourceUploadState } from '../../../../shared/generated/contracts';
const profile = { id: 'owned', baseUrl: 'https://owned.invalid' } as GatewayProfile;
const session = { sessionId: '10000000-0000-4000-8000-000000000001', targetId: 'source-owned', purpose: 'source' as const };
const ready = { status: 'ready', launching: false, ownedChildren: 1 };
const uploaded: SourceUploadState = { operationId: session.sessionId, manifestSha256: 'a'.repeat(64), source: 'codex', totalFiles: 1, totalBytes: 1, receivedBytes: 1, verifiedBytes: 1, completedFiles: 1, sequence: 8, cancelWatermark: 0, cancelRequested: false, stage: 'ready', workerState: 'stopped' };
const deferred = () => { let resolve!: (value: any) => void; const promise = new Promise<any>(yes => { resolve = yes; }); return { resolve, promise }; };
beforeEach(() => { fake.requests = []; fake.allowed = true; fake.handler = async () => ready; });

it('uses an explicit family-index query and cached ancestors across three ten-item pages without selecting a parent', async () => {
  fake.handler = async (path: string, body: any) => {
    if (path.endsWith('/open')) return ready; if (path.endsWith('/close')) return { status: 'released' };
    const q = body.query, start = q.kind === 'history_families' ? 0 : Number(q.params.cursor ?? 0);
    return { catalogId: 'family-owned', totalItems: 22, discoveryComplete: true, problems: [], nextCursor: start < 20 ? String(start + 10) : null,
      items: Array.from({ length: Math.min(10, 22 - start) }, (_, i) => { const at = start + i; return { source: 'codex', sourceHandle: `handle-${at}`, sourceSessionId: `session-${at}`, sourceArtifactId: `artifact-${at}`,
        parentSessionId: at === 0 ? null : at < 10 ? 'session-0' : at < 20 ? 'session-9' : 'session-19', agentId: null,
        title: `Physical ${at}`, project: at ? '/child-cwd' : '/root-cwd', bytes: 3, modifiedAtMs: null, archived: false, compressed: false, previewIncomplete: false, importIssues: [] }; }) };
  };
  const catalog = new MobileSourceCatalog({ profile, target: { id: 'source' }, captureScope: () => 'owned', isCurrent: () => true });
  await catalog.discover('history_families', 'codex'); catalog.select('handle-9'); await catalog.page(1); await catalog.page(2); catalog.select('handle-21');
  expect(catalog.snapshot().rows[0].historyGroup).toMatchObject({ sessionId: 'session-0', title: 'Physical 0', parentObserved: true, parentOnPage: false });
  expect((await catalog.selections()).selections).toEqual([{ kind: 'history', catalogId: 'family-owned', sourceHandle: 'handle-9' }, { kind: 'history', catalogId: 'family-owned', sourceHandle: 'handle-21' }]);
  expect(fake.requests.filter(row => row.body.query?.kind === 'history')).toHaveLength(0); await catalog.close();
});
it('keeps an old family source explicit and never starts a basic scan as fallback', async () => {
  fake.handler = async (path: string) => path.endsWith('/open') ? ready : path.endsWith('/close') ? { status: 'released' } : Promise.reject(new Error('source_transfer_unsupported_native'));
  const catalog = new MobileSourceCatalog({ profile, target: { id: 'old-source' }, captureScope: () => 'owned', isCurrent: () => true });
  await catalog.discover('history_families', 'codex'); expect(catalog.snapshot().error).toBe('source_transfer_unsupported_native'); expect(catalog.snapshot().rows).toEqual([]);
  expect(fake.requests.filter(row => row.body.query).map(row => row.body.query.kind)).toEqual(['history_families']); catalog.dispose();
});
it('uses the ordinary profile gate and rejects late account/scope results without replaying open', async () => {
  let scope = 'original'; const pending = deferred(); fake.handler = () => pending.promise;
  const client = createMigrationSourceSessionClient({ profile, captureScope: () => scope });
  const request = client.open(session); await vi.waitFor(() => expect(fake.requests).toHaveLength(1)); scope = 'peer'; pending.resolve(ready);
  await expect(request).rejects.toMatchObject({ code: 'source_transfer_authority_changed', outcomeUnknown: true }); expect(fake.requests).toHaveLength(1);
  fake.allowed = false; await expect(client.open(session)).rejects.toMatchObject({ outcomeUnknown: false }); expect(fake.requests).toHaveLength(1);
});
it('binds configuration reports to the original source only, rejects target jobs, pages and injected paths', async () => {
  const report = { target: { kind: 'source', sourceId: 'opaque' }, status: 'not_applicable', pageIndex: 0, adapterRevision: null, layers: [], fields: [], totalFields: 0, nextPage: null, unobserved: [] };
  fake.handler = async () => report;
  const client = createMigrationSourceSessionClient({ profile, captureScope: () => 'owned' });
  await expect(client.configurationLayersRead(session, { sourceId: 'opaque' })).resolves.toEqual(report);
  expect(fake.requests[0].body).toEqual({ session, query: { kind: 'configuration_layers_read', params: { sourceId: 'opaque' } } });
  for (const value of [{ ...report, target: { kind: 'job', jobId: 'peer' } }, { ...report, pageIndex: 1 }, { ...report, target: { kind: 'source', sourceId: 'other' } }]) {
    fake.handler = async () => value; await expect(client.configurationLayersRead(session, { sourceId: 'opaque' })).rejects.toMatchObject({ code: 'source_transfer_invalid_response', outcomeUnknown: false });
  }
  const before = fake.requests.length;
  await expect(client.configurationLayersRead(session, { sourceId: 'opaque', path: '/private' } as never)).rejects.toMatchObject({ outcomeUnknown: false }); expect(fake.requests).toHaveLength(before);
});
it('late source opens clean only their original child, including an acknowledgement after early release', async () => {
  const pending = deferred(); fake.handler = async (path: string) => path.endsWith('/open') ? pending.promise : { status: 'released' };
  const catalog = new MobileSourceCatalog({ profile, target: { id: 'original' }, captureScope: () => 'owned', isCurrent: () => true });
  const opening = catalog.discover('configuration', 'claude-code'); await vi.waitFor(() => expect(fake.requests.some(row => row.path.endsWith('/open'))).toBe(true));
  const owned = fake.requests.find(row => row.path.endsWith('/open'))!.body; catalog.dispose(); pending.resolve(ready); await opening;
  const closes = fake.requests.filter(row => row.path.endsWith('/close')); expect(closes.length).toBeGreaterThanOrEqual(1);
  expect(closes.every(row => JSON.stringify(row.body) === JSON.stringify(owned))).toBe(true); expect(fake.requests.some(row => row.path.endsWith('/query'))).toBe(false);
});
it('reconciles lost uploaded authorization on the same child and uses Native families rather than source-name guesses', async () => {
  let selectLost = true;
  fake.handler = async (path: string, body: any) => {
    if (path.endsWith('/open')) return ready;
    if (body.query.kind === 'uploaded_select') { if (selectLost) { selectLost = false; throw new Error('reply lost'); } return { operationId: uploaded.operationId, manifestSha256: uploaded.manifestSha256, source: 'codex', origin: 'user_supplied', remainingMs: 600000 }; }
    if (body.query.kind === 'configuration') return { sources: [{ sourceId: 'looks-like-provider', kind: 'codex', scope: 'user', displayName: 'source', formatRevision: 'fixture/v1', availableCategories: ['skill'] }], problems: [] };
    if (body.query.kind === 'source_bindings') return { bindings: [{ sourceId: 'looks-like-provider', family: 'assets' }] };
    throw new Error('unexpected');
  };
  const catalog = new MobileSourceCatalog({ profile, target: { id: 'target' }, captureScope: () => 'owned', isCurrent: () => true, uploaded });
  await catalog.discover('configuration', 'codex'); expect(catalog.snapshot().rows).toHaveLength(0);
  await catalog.discover('configuration', 'codex'); catalog.select('looks-like-provider');
  expect((await catalog.selections()).selections).toEqual([{ kind: 'assets', sourceId: 'looks-like-provider' }]);
  const opens = fake.requests.filter(row => row.path.endsWith('/open')); expect(opens[0].body).toEqual(opens[1].body);
  const kinds = fake.requests.filter(row => row.body.query).map(row => row.body.query.kind); expect(kinds).toEqual(['uploaded_select', 'uploaded_select', 'configuration', 'source_bindings']);
  catalog.dispose();
});
it('keeps ten-item Memory pages in one catalog, preserves 64 selections and refuses an invalid next catalog', async () => {
  fake.handler = async (path: string, body: any) => {
    if (path.endsWith('/open')) return ready;
    if (path.endsWith('/close')) return { status: 'released' };
    const q = body.query;
    if (q.kind === 'source_bindings') return { bindings: q.params.sourceIds.map((sourceId: string) => ({ sourceId, family: 'assets' })) };
    const index = q.kind === 'memory' ? 0 : Number(q.params.cursor);
    return { catalogId: 'owned-catalog', items: Array.from({ length: 10 }, (_, i) => ({ sourceId: `memory-${index * 10 + i}`, source: 'codex', sourceGroup: 'opaque', layout: 'codex_memory_files_v1', files: 1, bytes: 1, blockedItems: 0 })), nextCursor: index < 6 ? String(index + 1) : null, problems: [], unobserved: [] };
  };
  const catalog = new MobileSourceCatalog({ profile, target: { id: 'source' }, captureScope: () => 'owned', isCurrent: () => true });
  await catalog.discover('memory', 'codex');
  for (let page = 0; page < 7; page++) { if (page) await catalog.page(page); for (const row of catalog.snapshot().rows) catalog.select(row.id); }
  expect(catalog.snapshot().selected).toHaveLength(64); expect((await catalog.selections()).selections).toHaveLength(64);
  fake.handler = async () => ({ catalogId: 'peer', items: [], nextCursor: null, problems: [], unobserved: [] });
  await catalog.page(0); expect(catalog.snapshot().selected).toHaveLength(0); expect(catalog.snapshot().error).toBeTruthy(); catalog.dispose();
});
it('reconciles a lost directory grant on one child, forbids changing it to home, and closes before an explicit new choice', async () => {
  let lose = true;
  fake.handler = async (path: string, body: any) => {
    if (path.endsWith('/open')) return ready;
    if (path.endsWith('/close')) return { status: 'released' };
    if (body.query.kind === 'directory_select') { if (lose) { lose = false; throw new Error('acknowledgement lost'); } return { selectionId: body.query.params.selectionId, source: 'claude-code', remainingMs: 600000 }; }
    return body.query.kind === 'history' ? { catalogId: 'new-directory-catalog', items: [], nextCursor: null, problems: [], discoveryComplete: true, totalItems: 0 } : { sources: [], problems: [] };
  };
  const catalog = new MobileSourceCatalog({ profile, target: { id: 'owned' }, captureScope: () => 'owned', isCurrent: () => true });
  await catalog.discover('configuration', 'claude-code', false, '/owned/nondefault');
  expect(fake.requests.filter(row => row.body.query).map(row => row.body.query.kind)).toEqual(['directory_select']);
  await catalog.discover('configuration', 'claude-code');
  expect(catalog.snapshot().error).toBe('source_transfer_directory_changed');
  expect(fake.requests.filter(row => row.body.query)).toHaveLength(1);
  await catalog.discover('configuration', 'claude-code', false, '/owned/nondefault');
  const grants = fake.requests.filter(row => row.body.query?.kind === 'directory_select'); expect(grants).toHaveLength(2); expect(grants[0].body).toEqual(grants[1].body);
  expect(fake.requests.at(-1)!.body.query.kind).toBe('configuration');
  await catalog.close(); await catalog.discover('history', 'claude-code', false, '/owned/other');
  const later = fake.requests.filter(row => row.body.query?.kind === 'directory_select').at(-1)!;
  expect(later.body.session.sessionId).not.toBe(grants[0].body.session.sessionId); expect(catalog.snapshot().error).toBeNull(); catalog.dispose();
});
it('does not query a default home when an old source cannot authorize a directory', async () => {
  fake.handler = async (path: string) => { if (path.endsWith('/open')) return ready; if (path.endsWith('/close')) return { status: 'released' }; throw new Error('source_transfer_directory_update_required'); };
  const catalog = new MobileSourceCatalog({ profile, target: { id: 'old-native' }, captureScope: () => 'owned', isCurrent: () => true });
  await catalog.discover('memory', 'codex', false, '/owned/codex');
  expect(catalog.snapshot().error).toBe('source_transfer_directory_update_required');
  expect(fake.requests.filter(row => row.body.query).map(row => row.body.query.kind)).toEqual(['directory_select']); catalog.dispose();
});
it('a late authorized directory reply cleans its original child without discovering anything after close', async () => {
  const pending = deferred();
  fake.handler = async (path: string) => path.endsWith('/open') ? ready : path.endsWith('/close') ? { status: 'released' } : pending.promise;
  const catalog = new MobileSourceCatalog({ profile, target: { id: 'original-source' }, captureScope: () => 'owned', isCurrent: () => true });
  const reading = catalog.discover('history', 'claude-code', false, '/owned/source');
  await vi.waitFor(() => expect(fake.requests.some(row => row.body.query?.kind === 'directory_select')).toBe(true));
  const grant = fake.requests.find(row => row.body.query)?.body; catalog.dispose(); pending.resolve({ selectionId: grant.query.params.selectionId, source: 'claude-code', remainingMs: 600000 }); await reading;
  expect(fake.requests.filter(row => row.body.query)).toHaveLength(1);
  expect(fake.requests.filter(row => row.path.endsWith('/close')).every(row => row.body.sessionId === grant.session.sessionId && row.body.targetId === 'original-source')).toBe(true);
});
it('uses monotonic elapsed time for grants and refuses expired catalogs without reauthorization or home fallback', async () => {
  const now = vi.spyOn(performance, 'now').mockReturnValue(0);
  try {
    fake.handler = async (path: string, body: any) => path.endsWith('/open') ? ready : path.endsWith('/close') ? { status: 'released' } : body.query.kind === 'directory_select' ? { selectionId: body.query.params.selectionId, source: 'codex', remainingMs: 100 } : { sources: [{ sourceId: 'opaque', kind: 'codex', scope: 'user', displayName: 'config', formatRevision: 'fixture/v1', availableCategories: ['provider'] }], problems: [] };
    const catalog = new MobileSourceCatalog({ profile, target: { id: 'source' }, captureScope: () => 'owned', isCurrent: () => true });
    await catalog.discover('configuration', 'codex', false, '/owned/source'); catalog.select('opaque');
    const before = fake.requests.length; now.mockReturnValue(101); await catalog.page(0);
    expect(catalog.snapshot().error).toBe('source_transfer_catalog_expired'); expect(fake.requests).toHaveLength(before); expect(catalog.snapshot().selected).toHaveLength(0); catalog.dispose();
  } finally { now.mockRestore(); }
});
it('keeps project plugin grants in their original cursor catalog, never guesses asset families, and rejects unknown transfer readiness', async () => {
  const candidate = (index: number) => ({ candidateId: `plug-${index}`, source: 'codex', name: `plugin-${index}`, installedVersion: '1.0.0', scope: 'project', sourceEnabled: true, pending: ['plugin_project_mapping_required'] });
  fake.handler = async (path: string, body: any) => {
    if (path.endsWith('/open')) return ready;
    if (path.endsWith('/close')) return { status: 'released' };
    expect(body.query.kind).toBe('plugins'); expect(body.query.params.includeProject).toBe(true);
    const start = body.query.params.cursor ? 10 : 0;
    return { candidates: Array.from({ length: 10 }, (_, i) => candidate(start + i)), nextCursor: start ? null : 'original:10', problems: [] };
  };
  const catalog = new MobileSourceCatalog({ profile, target: { id: 'source', workspacePath: '/source-project' }, captureScope: () => 'owned', isCurrent: () => true });
  await catalog.discover('plugins', 'codex', true); catalog.select('plug-0'); await catalog.page(1); catalog.select('plug-10');
  expect((await catalog.selections()).selections).toEqual([{ kind: 'plugin', candidateId: 'plug-0' }, { kind: 'plugin', candidateId: 'plug-10' }]);
  expect(fake.requests.filter(row => row.body.query).every(row => row.body.query.kind === 'plugins')).toBe(true);
  fake.handler = async () => ({ candidates: [{ ...candidate(20), source: 'claude-code' }], nextCursor: null, problems: [] });
  await catalog.page(0); expect(catalog.snapshot().rows).toEqual([]); expect(catalog.snapshot().selected).toEqual([]);
  catalog.dispose();
});

it('requires an explicit source project grant before selecting a project plugin', async () => {
  fake.handler = async (path: string) => path.endsWith('/open') ? ready : path.endsWith('/close') ? { status: 'released' }
    : { candidates: [{ candidateId: 'project-plugin', source: 'codex', name: 'scoped', installedVersion: '1.0.0', scope: 'project', sourceEnabled: true, pending: ['plugin_project_mapping_required'] }], nextCursor: null, problems: [] };
  const catalog = new MobileSourceCatalog({ profile, target: { id: 'source', workspacePath: '/source-project' }, captureScope: () => 'owned', isCurrent: () => true });
  await catalog.discover('plugins', 'codex', false); expect(catalog.snapshot().rows[0].blocked).toBe(true);
  catalog.select('project-plugin'); expect(catalog.snapshot().selected).toEqual([]); catalog.dispose();
});

it('uses explicit uploaded plugin discovery on each ten-item page without authorizing recorded source project paths', async () => {
  fake.handler = async (path: string, body: any) => {
    if (path.endsWith('/open')) return ready;
    if (path.endsWith('/close')) return { status: 'released' };
    const q = body.query;
    if (q.kind === 'uploaded_select') return { operationId: uploaded.operationId, manifestSha256: uploaded.manifestSha256, source: 'codex', origin: 'user_supplied', remainingMs: 600000 };
    expect(q.kind).toBe('plugins'); expect(q.params.includeUploaded).toBe(true); expect(q.params.includeProject).toBe(false);
    const start = q.params.cursor ? 10 : 0;
    return { candidates: Array.from({ length: 10 }, (_, index) => ({ candidateId: `upload-${start + index}`, source: 'codex', name: `fixture-${index}`, installedVersion: '1.0.0', scope: 'local', sourceEnabled: null, pending: ['plugin_project_mapping_required'] })), problems: [], nextCursor: start ? null : 'same-upload:10' };
  };
  const catalog = new MobileSourceCatalog({ profile, target: { id: 'target' }, captureScope: () => 'owned', isCurrent: () => true, uploaded });
  await catalog.discover('plugins', 'codex', true); catalog.select('upload-0'); await catalog.page(1); catalog.select('upload-10');
  expect((await catalog.selections()).selections).toEqual([{ kind: 'plugin', candidateId: 'upload-0' }, { kind: 'plugin', candidateId: 'upload-10' }]);
  expect(fake.requests.filter(row => row.body.query?.kind === 'directory_select')).toHaveLength(0);
  expect(new Set(fake.requests.filter(row => row.body.query).map(row => row.body.session.sessionId)).size).toBe(1);
  await catalog.close();
});

it('keeps unsupported uploaded plugins unavailable rather than scanning the target home', async () => {
  fake.handler = async (path: string, body: any) => path.endsWith('/open') ? ready : path.endsWith('/close') ? { status: 'released' } : body.query.kind === 'uploaded_select' ? { operationId: uploaded.operationId, manifestSha256: uploaded.manifestSha256, source: 'codex', origin: 'user_supplied', remainingMs: 600000 } : Promise.reject(new Error('source_transfer_uploaded_update_required'));
  const catalog = new MobileSourceCatalog({ profile, target: { id: 'target' }, captureScope: () => 'owned', isCurrent: () => true, uploaded });
  await catalog.discover('plugins', 'codex'); expect(catalog.snapshot().error).toBe('source_transfer_uploaded_update_required');
  expect(fake.requests.filter(row => row.body.query).map(row => row.body.query.kind)).toEqual(['uploaded_select', 'plugins']);
  expect(catalog.snapshot().rows).toEqual([]); catalog.dispose();
});

it('keeps source family metadata, original labels and explicit child selections across history pages', async () => {
  const parent = { sourceHandle: 'parent-handle', source: 'claude-code', sourceSessionId: 'parent', title: 'Original parent title', agentId: null, parentSessionId: null, bytes: 7, archived: false, compressed: false, importIssues: [], previewIncomplete: false };
  const child = (index: number) => ({ ...parent, sourceHandle: `child-${index}`, title: `Original child ${index}`, agentId: `agent-${index}`, parentSessionId: 'parent' });
  fake.handler = async (path: string, body: any) => {
    if (path.endsWith('/open')) return ready;
    if (path.endsWith('/close')) return { status: 'released' };
    const next = body.query.kind === 'history_page' && body.query.params.cursor;
    return { catalogId: 'family-catalog', totalItems: 12, discoveryComplete: true, problems: [], nextCursor: next ? null : 'next', items: next ? [child(10), child(11)] : [parent, ...Array.from({ length: 9 }, (_, i) => child(i + 1))] };
  };
  const catalog = new MobileSourceCatalog({ profile, target: { id: 'owned' }, captureScope: () => 'owned', isCurrent: () => true });
  await catalog.discover('history', 'claude-code');
  expect(catalog.snapshot().rows).toHaveLength(10);
  expect(catalog.snapshot().rows[0]).toMatchObject({ label: 'Original parent title', historyGroup: { title: 'Original parent title', parentOnPage: true } });
  catalog.select('parent-handle');
  expect(catalog.snapshot().selected).toHaveLength(1);
  await catalog.page(1);
  expect(catalog.snapshot().rows).toHaveLength(2);
  expect(catalog.snapshot().rows[0]).toMatchObject({ label: 'Original child 10', historyGroup: { title: null, sessionId: 'parent', parentOnPage: false } });
  catalog.select('child-11');
  expect((await catalog.selections()).selections).toEqual([{ kind: 'history', catalogId: 'family-catalog', sourceHandle: 'parent-handle' }, { kind: 'history', catalogId: 'family-catalog', sourceHandle: 'child-11' }]);
  await catalog.page(0);
  expect(catalog.snapshot().selected.map(row => row.id)).toEqual(['parent-handle', 'child-11']);
  await catalog.close();
});

it.each(['too-many', 'duplicate', 'foreign-source'])('rejects an invalid first history page before it can expose selectable family rows: %s', async issue => {
  const row = { sourceHandle: 'opaque', source: 'claude-code', sourceSessionId: 'parent', title: 'Original', bytes: 7, archived: false, compressed: false, importIssues: [], previewIncomplete: false };
  fake.handler = async (path: string) => path.endsWith('/open') ? ready : path.endsWith('/close') ? { status: 'released' } : { catalogId: 'owned', totalItems: 11, discoveryComplete: true, problems: [], nextCursor: null, items: issue === 'too-many' ? Array.from({ length: 11 }, (_, index) => ({ ...row, sourceHandle: `opaque-${index}` })) : issue === 'duplicate' ? [row, row] : [{ ...row, source: 'codex' }] };
  const catalog = new MobileSourceCatalog({ profile, target: { id: 'owned' }, captureScope: () => 'owned', isCurrent: () => true });
  await catalog.discover('history', 'claude-code');
  expect(catalog.snapshot().error).toBe('source_transfer_invalid_response');
  expect(catalog.snapshot().rows).toEqual([]);
  expect(catalog.snapshot().selected).toEqual([]);
  await catalog.close();
});

it('pages project registries on the same source child, keeps explicit cross-page handles and refuses a substituted catalog', async () => {
  let changed = false;
  fake.handler = async (path: string, body: any) => {
    if (path.endsWith('/open')) return ready;
    if (path.endsWith('/close')) return { status: 'released' };
    const q = body.query, pageIndex = q.kind === 'projects' ? 0 : q.params.pageIndex;
    return { catalogId: changed ? 'substituted' : 'project-catalog', source: 'codex', pageIndex,
      items: Array.from({ length: pageIndex ? 3 : 10 }, (_, index) => ({ sourceHandle: `project-${pageIndex * 10 + index}`,displayName: `Original ${index}`,labelOrigin:'registry_name',originalProjectId:`id-${index}`,roots:1,position:pageIndex * 10 + index,sourceCreatedAtMs:null,sourceUpdatedAtMs:null })),
      totalItems:13,nextPage:pageIndex?null:1,knownRowsComplete:true,formatRevision:'codex-project-registry/sqlite/1',unobserved:['source_trust'],problems:[] };
  };
  const model = new MobileSourceCatalog({ profile, target:{id:'source'}, captureScope:()=> 'owned',isCurrent:()=>true });
  await model.discover('projects','codex'); model.select('project-0'); await model.page(1); model.select('project-12');
  expect((await model.selections()).selections).toEqual([{kind:'projects',catalogId:'project-catalog',sourceHandle:'project-0'},{kind:'projects',catalogId:'project-catalog',sourceHandle:'project-12'}]);
  changed = true; await model.page(0); expect(model.snapshot().selected).toEqual([]);expect(model.snapshot().rows).toEqual([]);await model.close();
  expect(new Set(fake.requests.filter(row=>row.body.query).map(row=>row.body.session.sessionId)).size).toBe(1);
});
