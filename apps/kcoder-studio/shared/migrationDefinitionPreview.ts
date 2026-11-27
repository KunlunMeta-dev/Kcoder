import type * as C from './generated/contracts';
interface Api { definitionReport(p: C.MigrationDefinitionReportParams): Promise<C.MigrationDefinitionReportResult>; definitionBody(p: C.MigrationDefinitionBodyParams): Promise<C.MigrationDefinitionBodyResult> }
interface State { busy: boolean; error: string; report: C.MigrationDefinitionReportResult | null; body: C.MigrationDefinitionBodyResult | null; offsets: number[] }
/** Text and bytes are local inert projections, never a tool input or automatic model context. */
export class DefinitionPreviewController {
  private state: State = { busy: false, error: '', report: null, body: null, offsets: [0] };
  private active = true;
  private generation = 0;
  private listeners = new Set<() => void>();
  private readonly api: Api;
  private readonly locator: { jobId: string; itemId: string };
  private readonly isCurrent: () => boolean;
  constructor(api: Api, locator: { jobId: string; itemId: string }, isCurrent: () => boolean) { this.api = api; this.locator = { ...locator }; this.isCurrent = isCurrent; }
  snapshot = () => this.state;
  subscribe = (f: () => void) => { this.listeners.add(f); return () => { this.listeners.delete(f); }; };
  activate = () => { this.active = true; };
  dispose = () => { this.active = false; this.generation++; };
  private current() { return this.active && this.isCurrent(); }
  private update(patch: Partial<State>) { if (this.current()) { this.state = { ...this.state, ...patch }; for (const f of this.listeners) f(); } }
  private async perform(work: () => Promise<Partial<State>>) {
    if (!this.current() || this.state.busy) return;
    const ticket = ++this.generation; this.update({ busy: true, error: '' });
    try { const patch = await work(); if (this.current() && ticket === this.generation) this.update(patch); }
    catch (error) { if (this.current() && ticket === this.generation) this.update({ error: error instanceof Error && ['migration_definitions_update_required', 'migration_update_required'].includes(error.message) ? 'updateRequired' : 'failed' }); }
    finally { if (this.current() && ticket === this.generation) this.update({ busy: false }); }
  }
  report = (pageIndex = 0) => this.perform(async () => ({ report: await this.api.definitionReport({ ...this.locator, pageIndex }) }));
  body = (offset = 0, offsets = [0]) => this.perform(async () => {
    const body = await this.api.definitionBody({ ...this.locator, offset }), old = this.state.body;
    if (old && (old.sha256 !== body.sha256 || old.totalBytes !== body.totalBytes)) throw new Error('migration_definition_snapshot_changed');
    return { body, offsets: offsets.slice(-256) };
  });
  next = () => { if (this.state.body?.nextOffset != null) return this.body(this.state.body.nextOffset, [...this.state.offsets, this.state.body.nextOffset]); };
  previous = () => { if (this.state.offsets.length > 1) { const offsets = this.state.offsets.slice(0, -1); return this.body(offsets.at(-1)!, offsets); } };
}
