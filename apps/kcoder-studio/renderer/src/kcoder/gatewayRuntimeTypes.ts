export interface GatewayClient extends EventTarget {
  connect(): Promise<void>
  request<T = unknown>(method: string, params?: Record<string, unknown>): Promise<T>
  respond?: (id: number, result: unknown) => void
  respondError?: (id: number, code: number, message: string, data?: unknown) => void
  close(): void
  supportsExperimental?: (capability: string) => boolean
  supportsThreadResume?: () => boolean
}
