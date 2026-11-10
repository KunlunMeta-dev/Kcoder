import type { WebSearchStatusReadParams, WebSearchStatusReadResult, WebSearchProbeStartParams, WebSearchProbeReadParams, WebSearchProbeResult } from '../../../shared/generated/contracts';
import { WEB_SEARCH_METHODS, webSearchCapability, validWebSearchParams, validWebSearchResult } from '../../../shared/webSearchMethods.mjs';

interface DiagnosticClient {
  supportsExperimental(capability: string): boolean;
  request<T>(method: string, params: unknown): Promise<T>;
}
/** One real target connection owns every probe; reads never start another search. */
export class MobileWebSearchDiagnostics {
  constructor(private readonly client: DiagnosticClient, private readonly isCurrent: () => boolean) {}
  private async request<T>(method: string, params: unknown): Promise<T> {
    const capability = webSearchCapability(method);
    if (!this.isCurrent()) throw new Error('SEARCH_TARGET_CHANGED');
    if (!capability || !this.client.supportsExperimental(capability)) throw new Error('SEARCH_DIAGNOSTIC_UNSUPPORTED');
    if (!validWebSearchParams(method, params)) throw new Error('SEARCH_DIAGNOSTIC_INVALID_REQUEST');
    const result = await this.client.request<unknown>(method, params);
    if (!this.isCurrent()) throw new Error('SEARCH_TARGET_CHANGED');
    if (!validWebSearchResult(method, result)) throw new Error('SEARCH_DIAGNOSTIC_INVALID_RESULT');
    return result as T;
  }
  status(params: WebSearchStatusReadParams) { return this.request<WebSearchStatusReadResult>(WEB_SEARCH_METHODS.status, params); }
  start(params: WebSearchProbeStartParams) { return this.request<WebSearchProbeResult>(WEB_SEARCH_METHODS.start, params); }
  read(params: WebSearchProbeReadParams) { return this.request<WebSearchProbeResult>(WEB_SEARCH_METHODS.read, params); }
  cancel(params: WebSearchProbeReadParams) { return this.request<WebSearchProbeResult>(WEB_SEARCH_METHODS.cancel, params); }
}
