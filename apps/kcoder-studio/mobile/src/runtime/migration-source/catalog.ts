import { PROJECTS_METHODS, validProjectCall } from '../../../../shared/migrationProjects';
import { historySourceGroups, type HistorySourceGroup } from '../../../../shared/migrationHistoryGroups';
import { HistoryFamilyCache, type HistoryFamilyGroup, validHistorySources } from '../../../../shared/migrationHistoryFamilies';
import { transferablePlugin, validPluginDiscovery } from '../../../../shared/migrationPlugins';
import { createSourceDirectoryIntent } from './directory-intent';
import { migrationRequestId } from '../migration-client';
import { createMigrationSourceSessionClient } from './sessions';
import { MigrationSourceHttpError, type MigrationSourceHttpOptions } from './http';
import * as C from '../../../../shared/generated/contracts';
export interface SourceTarget { id: string; workspacePath?: string }
export interface SourceRow { historyGroup?: Pick<HistorySourceGroup, 'sessionId' | 'title' | 'parentOnPage' | 'related'> & Partial<Pick<HistoryFamilyGroup, 'parentObserved' | 'lineageIssue'>>; id: string; label: string; detail: string; blocked: boolean; compressed?: boolean; archived?: boolean; selection?: C.MigrationSourceSelectionV1 }
export type SourceMode = 'configuration' | 'history' | 'history_families' | 'memory' | 'definitions' | 'plugins' | 'projects';
interface State { busy: boolean; error: string | null; releasePending: boolean; session: C.MigrationSourceSessionParams | null; rows: SourceRow[]; selected: SourceRow[]; pageIndex: number; hasNext: boolean; problems: string[]; report: C.MigrationConfigurationLayersResult | null; codexReport: C.MigrationCodexLayersReadResult | null; familyMode: boolean }
const empty = (): State => ({ busy: false, error: null, releasePending: false, session: null, rows: [], selected: [], pageIndex: 0, hasNext: false, problems: [], report: null, codexReport: null, familyMode: false });
const clock = () => performance.now();
function validHistoryPage(value: unknown, kind: C.MigrationSourceKind): value is C.MigrationHistorySourcesResult {
  return C.isMigrationHistorySourcesResult(value) && !!value.catalogId && value.items.length <= 10
    && Number.isSafeInteger(value.totalItems) && value.totalItems >= value.items.length
    && (value.totalItems === 0 || value.items.length > 0)
    && value.items.every(row => row.source === kind && !!row.sourceHandle)
    && new Set(value.items.map(row => row.sourceHandle)).size === value.items.length;
}
/** Catalog references and late cleanup remain in one original, dedicated source child. */
export class MobileSourceCatalog {
  private state = empty();
  private active = true;
  private epoch = 0;
  private listeners = new Set<() => void>();
  private resource: { session: C.MigrationSourceSessionParams; released: boolean; authorized: boolean; expires: number; directory: ReturnType<typeof createSourceDirectoryIntent> } | null = null;
  private readonly owner = migrationRequestId();
  private readonly api;
  private readonly cleanupApi;
  private mode: SourceMode = 'configuration';
  private kind: C.MigrationSourceKind = 'claude-code';
  private projectConsent = false;
  private config: C.MigrationSourceSummary[] = [];
  private catalogId: string | null = null;
  private cursors: Array<string | null> = [null];
  private family: { scope: string; cache: HistoryFamilyCache; total: number | null } | null = null;
  constructor(private options: MigrationSourceHttpOptions & { target: SourceTarget; isCurrent(): boolean; uploaded?: C.SourceUploadState }) {
    this.options = { ...options, target: { ...options.target }, ...(options.uploaded ? { uploaded: { ...options.uploaded } } : {}) };
    this.api = createMigrationSourceSessionClient({ profile: options.profile, captureScope: () => this.current() ? this.owner : '' });
    this.cleanupApi = createMigrationSourceSessionClient({ profile: options.profile, captureScope: () => this.owner });
  }
  snapshot = () => this.state;
  subscribe = (listener: () => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; };
  activate = () => { this.active = true; };
  private current() { return this.active && this.options.isCurrent(); }
  private update(patch: Partial<State>) { if (this.current()) { this.state = { ...this.state, ...patch }; for (const f of this.listeners) f(); } }
  private check() { if (!this.current()) throw new MigrationSourceHttpError('source_transfer_authority_changed', false); }
  private async release(resource: NonNullable<MobileSourceCatalog['resource']>) {
    try { resource.released = (await this.cleanupApi.close(resource.session)).status === 'released'; } catch { /* Original owner remains uncertain; no peer session is substituted. */ }
    return resource.released;
  }
  dispose = () => { this.active = false; this.epoch++; if (this.resource) void this.release(this.resource); };
  close = async () => {
    if (!this.current() || this.state.busy || !this.resource) return;
    this.update({ busy: true }); const released = await this.release(this.resource);
    if (released) { this.resource = null; this.update(empty()); } else this.update({ busy: false, releasePending: true, rows: [], selected: [] });
  };
  private historyRows(value: C.MigrationHistorySourcesResult): SourceRow[] {
    const groups: Array<HistorySourceGroup & Partial<Pick<HistoryFamilyGroup, 'parentObserved' | 'lineageIssue'>>> =
      this.family ? this.family.cache.observe(this.family.scope, value) : historySourceGroups(value.items);
    return groups.flatMap(group => group.items.map((row, index) => ({ ...(index === 0 && (group.related || group.items.length > 1 || 'lineageIssue' in group && group.lineageIssue) ? { historyGroup: { sessionId: group.sessionId, title: group.title, parentOnPage: group.parentOnPage, related: group.related,
      ...('parentObserved' in group ? { parentObserved: group.parentObserved, lineageIssue: group.lineageIssue } : {}) } } : {}), id: row.sourceHandle, label: row.title || row.sourceSessionId, detail: String(row.bytes), compressed: row.compressed, archived: row.archived, blocked: row.importIssues.length > 0, selection: { kind: 'history' as const, catalogId: value.catalogId, sourceHandle: row.sourceHandle } })));
  }
  private projectRows(value: C.MigrationProjectSourcesResult): SourceRow[] { return value.items.map(row => ({ id: row.sourceHandle, label: row.displayName, detail: String(row.roots), blocked: false,
    selection: { kind: 'projects', catalogId: value.catalogId, sourceHandle: row.sourceHandle } })); }
  private memoryRows(value: C.MigrationMemorySourcesResult): SourceRow[] { return value.items.map(row => ({ id: row.sourceId, label: row.sourceGroup, detail: `${row.layout} · ${row.files}`, blocked: false })); }
  private pluginRows(value: C.MigrationPluginDiscoverResult): SourceRow[] { return value.candidates.map(row => ({ id: row.candidateId, label: row.name, detail: `${row.scope} · ${row.installedVersion ?? ''}`, blocked: !transferablePlugin(row) || row.scope !== 'user' && !this.projectConsent && !this.options.uploaded, selection: { kind: 'plugin', candidateId: row.candidateId } })); }
  private configRows(index: number): SourceRow[] { return this.config.slice(index * 10, index * 10 + 10).map(row => ({ id: row.sourceId, label: row.displayName, detail: row.scope, blocked: false })); }
  discover = async (mode: SourceMode, kind: C.MigrationSourceKind, includeProject = false, directory?: string) => {
    if (!this.current() || this.state.busy) return;
    const ticket = ++this.epoch; this.update({ busy: true, error: null, selected: [], rows: [], pageIndex: 0, problems: [], report: null, codexReport: null, familyMode: mode === 'history_families' });
    let resource = this.resource;
    try {
      if (mode === 'projects' && this.options.uploaded) throw new MigrationSourceHttpError('source_transfer_projects_uploaded_unsupported', false);
      if (mode === 'history_families' && kind !== 'codex') throw new MigrationSourceHttpError('source_transfer_history_catalog_unavailable', false);
      if (this.options.uploaded && directory !== undefined) throw new MigrationSourceHttpError('source_transfer_uploaded_binding_changed', false);
      if (resource && (this.mode !== mode || this.kind !== kind) && !resource.released) {
        if (!await this.release(resource)) throw new MigrationSourceHttpError('source_transfer_release_pending', false);
        resource = null;
      }
      this.check(); this.mode = mode; this.kind = kind; this.projectConsent = !this.options.uploaded && includeProject; this.cursors = [null]; this.catalogId = null;
      if (!resource || resource.released) resource = { session: { sessionId: migrationRequestId(), purpose: 'source', targetId: this.options.target.id, ...(this.options.target.workspacePath === undefined ? {} : { workspacePath: this.options.target.workspacePath }) }, released: false, authorized: false, expires: 0, directory: createSourceDirectoryIntent(kind, directory) };
      if (!resource.directory.matches(kind, directory)) throw new MigrationSourceHttpError('source_transfer_directory_changed', false);
      this.resource = resource; this.update({ session: resource.session, releasePending: false });
      const familyScope = JSON.stringify([this.owner, resource.session.sessionId, this.options.target.id, this.options.target.workspacePath ?? null, ticket]);
      this.family = mode === 'history_families' ? { scope: familyScope, cache: new HistoryFamilyCache(familyScope), total: null } : null;
      const opened = await this.api.open(resource.session); this.check();
      if (opened.status !== 'ready') throw new MigrationSourceHttpError('source_transfer_source_not_ready', false);
      const uploaded = this.options.uploaded;
      if (uploaded) {
        if (uploaded.stage !== 'ready' || uploaded.source !== kind) throw new MigrationSourceHttpError('source_transfer_uploaded_binding_changed', false);
        if (!resource.authorized || clock() >= resource.expires) {
          const start = clock(), bound = await this.api.selectUploaded(resource.session, { operationId: uploaded.operationId, manifestSha256: uploaded.manifestSha256 }); this.check();
          if (bound.source !== kind || bound.remainingMs <= clock() - start) throw new MigrationSourceHttpError('source_transfer_uploaded_binding_changed', false);
          resource.authorized = true; resource.expires = start + bound.remainingMs;
        }
      }
      if (!uploaded) resource.expires = await resource.directory.authorize(this.api, resource.session, () => this.current() && resource === this.resource && ticket === this.epoch);
      const query: C.MigrationSourceSessionQueryParams['query'] = mode === 'projects' ? { kind: 'projects', params: { source: kind } } : mode === 'plugins' ? { kind: 'plugins', params: { sources: [kind], includeProject: this.projectConsent, ...(uploaded ? { includeUploaded: true } : {}) } } : mode === 'definitions' ? { kind: 'definitions', params: { sources: [kind], includeProject: uploaded ? false : includeProject, pageIndex: 0 } } : mode === 'configuration' ? { kind: 'configuration', params: { sources: [kind], includeProject: uploaded ? false : includeProject } } : mode === 'history' ? { kind: 'history', params: { source: kind } } : { kind: 'memory', params: { source: kind } };
      const value = mode === 'history_families' ? await this.api.historyFamilies(resource.session, { source: 'codex' }) : await this.api.query({ session: resource.session, query }); this.check(); if (ticket !== this.epoch) return;
      if (mode === 'projects' && C.isMigrationProjectSourcesResult(value) && validProjectCall(PROJECTS_METHODS.discover, { source: kind }, value)) {
        this.catalogId = value.catalogId; this.update({ rows: this.projectRows(value), hasNext: value.nextPage != null, problems: [...value.problems, ...(!value.knownRowsComplete ? ['project_registry_incomplete'] : [])] });
      } else if (mode === 'plugins' && validPluginDiscovery({ sources: [kind] }, value)) {
        if (value.nextCursor) this.cursors.push(value.nextCursor); this.update({ rows: this.pluginRows(value), hasNext: !!value.nextCursor, problems: value.problems.map(row => row.code) });
      } else if (mode === 'definitions' && C.isMigrationDefinitionsDiscoverResult(value)) {
        this.catalogId = value.catalogId; this.config = value.sources; this.update({ rows: this.configRows(0), hasNext: value.nextPage != null, problems: value.problems.map(row => row.code) });
      } else if (mode === 'configuration' && C.isMigrationDiscoverResult(value) && value.sources.length <= 1024) {
        this.config = value.sources; this.update({ rows: this.configRows(0), hasNext: this.config.length > 10, problems: value.problems?.map(row => row.code) ?? [] });
      } else if ((mode === 'history' || mode === 'history_families') && validHistoryPage(value, kind)) {
        if (this.family) { if (!validHistorySources('codex', value)) throw new Error('catalog'); this.family.total = value.totalItems; }
        this.catalogId = value.catalogId; if (value.nextCursor) this.cursors.push(value.nextCursor);
        this.update({ rows: this.historyRows(value), hasNext: !!value.nextCursor, problems: value.problems.map(row => row.code) });
      } else if (mode === 'memory' && C.isMigrationMemorySourcesResult(value) && value.items.every(row => row.source === kind)) {
        this.catalogId = value.catalogId; if (value.nextCursor) this.cursors.push(value.nextCursor);
        this.update({ rows: this.memoryRows(value), hasNext: !!value.nextCursor, problems: [...value.problems.map(row => row.code), ...value.unobserved] });
      } else throw new MigrationSourceHttpError('source_transfer_invalid_response', false);
    } catch (error) { this.update({ error: error instanceof MigrationSourceHttpError ? error.code : 'source_transfer_outcome_unknown', rows: [], selected: [], releasePending: error instanceof MigrationSourceHttpError && error.code === 'source_transfer_release_pending' }); }
    finally { if (this.current() && ticket === this.epoch) this.update({ busy: false }); else if (resource) { resource.released = false; await this.release(resource); } }
  };
  page = async (index: number) => {
    if (!this.current() || this.state.busy || !this.resource || !Number.isSafeInteger(index) || index < 0) return;
    this.update({ busy: true, error: null });
    try {
      if ((this.options.uploaded || this.resource.directory.explicit) && clock() >= this.resource.expires) throw new MigrationSourceHttpError('source_transfer_catalog_expired', false);
      if (this.mode === 'projects') {
        if (!this.catalogId) throw new Error('catalog');
        const params = { catalogId: this.catalogId, pageIndex: index };
        const value = await this.api.query({ session: this.resource.session, query: { kind: 'projects_page', params } }); this.check();
        if (!C.isMigrationProjectSourcesResult(value) || value.source !== this.kind || !validProjectCall(PROJECTS_METHODS.sources, params, value)) throw new Error('catalog');
        const rows = this.projectRows(value);
        if (rows.some(row => { const old = this.state.selected.find(old => old.id === row.id); return old && JSON.stringify(old) !== JSON.stringify(row); })) throw new Error('catalog');
        this.update({ rows, pageIndex: index, hasNext: value.nextPage != null }); return;
      }
      if (this.mode === 'plugins') {
        const cursor = this.cursors[index]; if (index > 0 && !cursor) throw new Error('cursor');
        const params = { sources: [this.kind], includeProject: this.projectConsent, ...(this.options.uploaded ? { includeUploaded: true } : {}), cursor };
        const value = await this.api.plugins(this.resource.session, params); this.check();
        if (!validPluginDiscovery(params, value) || value.nextCursor && this.cursors.slice(0, index + 1).includes(value.nextCursor)) throw new Error('catalog');
        const rows = this.pluginRows(value);
        for (const row of rows) { const old = this.state.selected.find(item => item.id === row.id); if (old && JSON.stringify(old) !== JSON.stringify(row)) throw new Error('changed row'); }
        this.cursors = this.cursors.slice(0, index + 1); if (value.nextCursor) this.cursors.push(value.nextCursor);
        this.update({ rows, pageIndex: index, hasNext: !!value.nextCursor }); return;
      }
      if (this.mode === 'definitions') {
        if (!this.catalogId) throw new Error('catalog');
        const value = await this.api.definitionsDiscover(this.resource.session, { sources: [this.kind], includeProject: this.projectConsent, catalogId: this.catalogId, pageIndex: index }); this.check();
        if (value.catalogId !== this.catalogId || value.sources.some(row => { const old = this.state.selected.find(item => item.id === row.sourceId); return old && (old.label !== row.displayName || old.detail !== row.scope); })) throw new Error('catalog');
        this.config = value.sources; this.update({ rows: this.configRows(0), pageIndex: index, hasNext: value.nextPage != null }); return;
      }
      if (this.mode === 'configuration') { if (index * 10 >= this.config.length) throw new Error('page'); this.update({ rows: this.configRows(index), pageIndex: index, hasNext: (index + 1) * 10 < this.config.length }); return; }
      const cursor = this.cursors[index]; if (index > 0 && !cursor || !this.catalogId) throw new Error('cursor');
      const history = this.mode === 'history' || this.mode === 'history_families';
      const query: C.MigrationSourceSessionQueryParams['query'] = history ? { kind: 'history_page', params: { catalogId: this.catalogId, cursor } } : { kind: 'memory_page', params: { catalogId: this.catalogId, cursor } };
      const value = await this.api.query({ session: this.resource.session, query }); this.check();
      if (!(history ? validHistoryPage(value, this.kind) : C.isMigrationMemorySourcesResult(value)) || !('catalogId' in value) || value.catalogId !== this.catalogId || !('items' in value) || value.items.length > 10 || !('nextCursor' in value)) throw new Error('catalog');
      if (this.family && !validHistorySources('codex', value, { catalogId: this.catalogId, cursor, totalItems: this.family.total ?? undefined })) throw new Error('catalog');
      if (value.nextCursor && this.cursors.slice(0, index + 1).includes(value.nextCursor)) throw new Error('cursor cycle');
      this.cursors = this.cursors.slice(0, index + 1); if (value.nextCursor) this.cursors.push(value.nextCursor);
      const rows = history ? this.historyRows(value as C.MigrationHistorySourcesResult) : this.memoryRows(value as C.MigrationMemorySourcesResult);
      const physical = (row: SourceRow) => { const { historyGroup: _display, ...original } = row; return original; };
      for (const row of rows) { const old = this.state.selected.find(item => item.id === row.id); if (old && JSON.stringify(this.family ? physical(old) : old) !== JSON.stringify(this.family ? physical(row) : row)) throw new Error('changed row'); }
      this.update({ rows, pageIndex: index, hasNext: !!value.nextCursor });
    } catch (error) { this.update({ error: error instanceof MigrationSourceHttpError ? error.code : 'source_transfer_invalid_response', rows: [], selected: [] }); }
    finally { this.update({ busy: false }); }
  };
  select = (id: string) => {
    if (!this.current() || this.state.busy) return;
    const row = this.state.rows.find(value => value.id === id); if (!row || row.blocked) return;
    const next = this.state.selected.filter(value => value.id !== id); if (next.length === this.state.selected.length && next.length < 64) next.push(row);
    this.update({ selected: next });
  };
  report = async (sourceId: string, pageIndex = 0) => {
    if (!this.current() || this.state.busy || !this.resource || this.mode !== 'configuration' || !this.config.some(row => row.sourceId === sourceId)) return;
    const resource = this.resource, ticket = this.epoch; this.update({ busy: true, error: null, report: null });
    try {
      const report = await this.api.configurationLayersRead(resource.session, { sourceId, pageIndex }); this.check();
      if (resource !== this.resource || ticket !== this.epoch) throw new MigrationSourceHttpError('source_transfer_authority_changed', false);
      this.update({ report });
    } catch (error) { this.update({ error: error instanceof MigrationSourceHttpError ? error.code : 'source_transfer_outcome_unknown' }); }
    finally { this.update({ busy: false }); }
  };
  mergeCodex = async (sourceId: string) => {
    if (!this.current() || this.state.busy || !this.resource || this.mode !== 'configuration' || this.kind !== 'codex' || !this.projectConsent || !this.config.some(row => row.sourceId === sourceId && row.scope === 'user')) return;
    const resource = this.resource, ticket = this.epoch; this.update({ busy: true, error: null });
    try {
      const value = await this.api.codexLayersSelect(resource.session, { sourceId, includeProject: true }); this.check();
      if (resource !== this.resource || ticket !== this.epoch) throw new MigrationSourceHttpError('source_transfer_authority_changed', false);
      const selected = this.state.selected.filter(row => !value.replacesSourceIds.includes(row.id));
      const row: SourceRow = { id: value.source.sourceId, label: value.source.displayName, detail: value.source.scope, blocked: false };
      if (selected.length >= 64) throw new MigrationSourceHttpError('source_transfer_selection_budget', false);
      this.config = [value.source, ...this.config.filter(row => row.sourceId !== value.source.sourceId && !value.replacesSourceIds.includes(row.sourceId))];
      selected.push(row); this.update({ rows: this.configRows(0), selected, pageIndex: 0, hasNext: this.config.length > 10, report: null, codexReport: null });
    } catch (error) { this.update({ error: error instanceof MigrationSourceHttpError ? error.code : 'source_transfer_outcome_unknown' }); }
    finally { this.update({ busy: false }); }
  };
  readCodex = async (sourceId: string, pageIndex = 0) => {
    if (!this.current() || this.state.busy || !this.resource || this.mode !== 'configuration' || !this.config.some(row => row.sourceId === sourceId && row.scope === 'codex-project-layers')) return;
    const resource = this.resource, ticket = this.epoch; this.update({ busy: true, error: null, codexReport: null });
    try {
      const codexReport = await this.api.codexLayersRead(resource.session, { sourceId, pageIndex }); this.check();
      if (resource !== this.resource || ticket !== this.epoch) throw new MigrationSourceHttpError('source_transfer_authority_changed', false);
      this.update({ codexReport });
    } catch (error) { this.update({ error: error instanceof MigrationSourceHttpError ? error.code : 'source_transfer_outcome_unknown' }); }
    finally { this.update({ busy: false }); }
  };
  selections = async (): Promise<{ session: C.MigrationSourceSessionParams; selections: C.MigrationSourceSelectionV1[] }> => {
    this.check(); const resource = this.resource;
    if (!resource || this.state.busy || !this.state.selected.length || this.state.selected.length > 64 || (this.options.uploaded || resource.directory.explicit) && clock() >= resource.expires) throw new MigrationSourceHttpError('source_transfer_catalog_expired', false);
    if (this.mode === 'projects' || this.mode === 'history' || this.mode === 'history_families' || this.mode === 'plugins') return { session: resource.session, selections: this.state.selected.map(row => row.selection!) };
    const selected = [...this.state.selected], ticket = this.epoch, mode = this.mode;
    const selections: C.MigrationSourceSelectionV1[] = []; this.update({ busy: true });
    try {
      for (let i = 0; i < selected.length; i += 10) {
        const rows = selected.slice(i, i + 10), result = await this.api.bindings(resource.session, rows.map(row => row.id)); this.check();
        if (this.resource !== resource || this.epoch !== ticket || (this.options.uploaded || resource.directory.explicit) && clock() >= resource.expires) throw new MigrationSourceHttpError('source_transfer_catalog_expired', false);
        if ((mode === 'memory' || mode === 'definitions') && result.bindings.some(row => row.family !== 'assets')) throw new MigrationSourceHttpError('source_transfer_invalid_response', false);
        for (const row of result.bindings) selections.push({ kind: row.family, sourceId: row.sourceId });
      }
      return { session: resource.session, selections };
    } finally { this.update({ busy: false }); }
  };
}
