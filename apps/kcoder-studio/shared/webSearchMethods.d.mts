export const WEB_SEARCH_METHODS: Readonly<{ status: 'webSearch/status/read'; start: 'webSearch/probe/start'; read: 'webSearch/probe/read'; cancel: 'webSearch/probe/cancel' }>
export function webSearchMethod(method: unknown): boolean
export function webSearchCapability(method: string): string | undefined
export function validWebSearchParams(method: string, value: unknown): boolean
export function validWebSearchResult(method: string, value: unknown): boolean
export function webSearchProbeRejection(error: unknown): 'unsupported' | 'policy_denied' | 'rejected' | null
