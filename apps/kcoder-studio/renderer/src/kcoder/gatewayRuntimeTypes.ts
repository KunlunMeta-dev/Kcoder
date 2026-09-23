export interface GatewayClient extends EventTarget {
  readonly diagnosticConnection?: import('./backgroundRunDiagnostic').DiagnosticConnection
  connect(): Promise<void>
  request<T = unknown>(method: string, params?: Record<string, unknown>, options?: { signal?: AbortSignal }): Promise<T>
  respond?: (id: number, result: unknown) => void
  respondError?: (id: number, code: number, message: string, data?: unknown) => void
  close(): void
  supportsExperimental?: (capability: string) => boolean
  supportsThreadResume?: () => boolean
}
