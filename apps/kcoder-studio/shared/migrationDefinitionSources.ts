import type * as C from './generated/contracts';
export interface DefinitionSourcesApi {
  definitionsDiscover(p: C.MigrationDefinitionsDiscoverParams): Promise<C.MigrationDefinitionsDiscoverResult>;
  scan(ids: string[]): Promise<string>;
}
interface State { busy: boolean; error: string; kind: C.MigrationSourceKind; includeProject: boolean; page: C.MigrationDefinitionsDiscoverResult | null; index: number; selected: C.MigrationSourceSummary[]; partial: boolean; scanUnknown: boolean }
/** Source selectors are opaque Native references. No source definition is executed here. */
export class DefinitionSourcesController {
  private state: State = { busy: false, error: '', kind: 'claude-code', includeProject: false, page: null, index: 0, selected: [], partial: false, scanUnknown: false };
  private active = true;
  private generation = 0;
  private listeners = new Set<() => void>();
  private readonly api: DefinitionSourcesApi;
  private readonly isCurrent: () => boolean;
  constructor(api: DefinitionSourcesApi, isCurrent: () => boolean) { this.api = api; this.isCurrent = isCurrent; }
  snapshot = () => this.state;
  subscribe = (f: () => void) => { this.listeners.add(f); return () => { this.listeners.delete(f); }; };
  activate = () => { this.active = true; };
  dispose = () => { this.active = false; this.generation++; };
  current = () => this.active && this.isCurrent();
  private update(patch: Partial<State>) { if (this.current()) { this.state = { ...this.state, ...patch }; for (const f of this.listeners) f(); } }
  configure = (kind: C.MigrationSourceKind, includeProject: boolean) => {
    if (!this.current() || this.state.busy || this.state.scanUnknown) return;
    this.generation++; this.update({ kind, includeProject, page: null, selected: [], index: 0, error: '', partial: false });
  };
  select = (sourceId: string) => {
    if (!this.current() || this.state.busy || this.state.scanUnknown) return;
    const row = this.state.page?.sources.find(row => row.sourceId === sourceId); if (!row) return;
    const selected = this.state.selected.filter(value => value.sourceId !== sourceId);
    if (selected.length === this.state.selected.length && selected.length < 64) selected.push(row);
    this.update({ selected });
  };
  consent = (partial: boolean) => { if (!this.state.busy) this.update({ partial }); };
  private async perform<T>(work: (valid: () => boolean) => Promise<T>, scanning = false): Promise<T | undefined> {
    if (!this.current() || this.state.busy || this.state.scanUnknown) return;
    const ticket = ++this.generation, valid = () => this.current() && ticket === this.generation;
    this.update({ busy: true, error: '' });
    try { const value = await work(valid); return valid() ? value : undefined; }
    catch (error) { if (valid()) this.update({ error: error instanceof Error && ['migration_definitions_update_required', 'migration_update_required'].includes(error.message) ? 'updateRequired' : scanning ? 'scanUnknown' : 'failed', ...(scanning ? { scanUnknown: true } : {}) }); }
    finally { if (valid()) this.update({ busy: false }); }
  }
  discover = () => this.perform(async valid => {
    const value = await this.api.definitionsDiscover({ sources: [this.state.kind], includeProject: this.state.includeProject, pageIndex: 0 });
    if (valid()) this.update({ page: value, index: 0, selected: [], partial: false });
  });
  page = (index: number) => this.perform(async valid => {
    const old = this.state.page; if (!old || !Number.isSafeInteger(index) || index < 0 || index * 10 >= old.totalSources) return;
    const value = await this.api.definitionsDiscover({ sources: [this.state.kind], includeProject: this.state.includeProject, catalogId: old.catalogId, pageIndex: index });
    if (!valid()) return;
    if (value.catalogId !== old.catalogId || value.totalSources !== old.totalSources || value.sources.some(row => { const selected = this.state.selected.find(v => v.sourceId === row.sourceId); return selected && JSON.stringify(row) !== JSON.stringify(selected); })) { this.update({ selected: [] }); throw new Error('migration_invalid_response'); }
    this.update({ page: value, index });
  });
  prepare = () => {
    if (!this.state.selected.length || this.state.selected.length > 64 || this.state.page?.problems.length && !this.state.partial) { this.update({ error: 'failed' }); return Promise.resolve(undefined); }
    return this.perform(async valid => {
      const id = await this.api.scan(this.state.selected.map(row => row.sourceId));
      return valid() ? id : undefined;
    }, true);
  };
}
