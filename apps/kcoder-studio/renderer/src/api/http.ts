import { getToken as defaultGetToken } from './auth'

const SLOW_HTTP_REQUEST_MS = 5000

function nowMs(): number {
  return typeof performance !== 'undefined' ? performance.now() : Date.now()
}

function logSlowHttpRequest(
  method: string,
  baseUrl: string,
  endpoint: string,
  elapsedMs: number,
  status?: number
): void {
  if (elapsedMs <= SLOW_HTTP_REQUEST_MS) return
  console.warn(`[KCoder Studio] HTTP ${method} ${endpoint} completed slowly in ${elapsedMs}ms.`, {
    method,
    baseUrl,
    endpoint,
    elapsedMs,
    status,
    transport: 'fetch',
  })
}

function requestUrl(baseUrl: string, endpoint: string): string {
  return `${baseUrl}${endpoint}`
}

function httpFetch(): typeof fetch {
  return globalThis.fetch.bind(globalThis)
}

export class ApiError extends Error {
  status: number
  errorCode?: string | number
  detail?: unknown

  constructor(message: string, status: number, errorCode?: string | number, detail?: unknown) {
    super(message)
    this.name = 'ApiError'
    this.status = status
    this.errorCode = errorCode
    this.detail = detail
  }
}

export interface HttpClientOptions {
  baseUrl: string
  getToken?: () => string | null
}

export interface HttpRequestOptions {
  signal?: AbortSignal
}

export interface HttpClient {
  get<T>(endpoint: string, options?: HttpRequestOptions): Promise<T>
  post<T>(endpoint: string, data?: unknown, options?: HttpRequestOptions): Promise<T>
  put<T>(endpoint: string, data?: unknown): Promise<T>
  patch<T>(endpoint: string, data?: unknown): Promise<T>
  delete<T>(endpoint: string, data?: unknown): Promise<T>
}

async function parseError(response: Response): Promise<ApiError> {
  const errorText = await response.text()
  let message = errorText
  let errorCode: string | number | undefined
  let detail: unknown

  try {
    const json = JSON.parse(errorText)
    detail = json.errors ? { detail: json.detail, errors: json.errors } : json.detail
    if (typeof json.detail === 'string') {
      message = json.detail
    } else if (json.detail && typeof json.detail === 'object') {
      if (typeof json.detail.message === 'string') {
        message = json.detail.message
      }
      if (json.detail.error_code || json.detail.code) {
        errorCode = json.detail.error_code ?? json.detail.code
      }
    }
    if (json.error_code) {
      errorCode = json.error_code
    }
    if (json.error && typeof json.error === 'object') {
      detail = json.error
      if (typeof json.error.message === 'string') {
        message = json.error.message
      }
      if (json.error.code || json.error.error_code) {
        errorCode = json.error.code ?? json.error.error_code
      }
    }
  } catch {
    message = errorText || `HTTP ${response.status}`
  }

  return new ApiError(message, response.status, errorCode, detail)
}

export function createHttpClient(options: HttpClientOptions): HttpClient {
  const getToken = options.getToken ?? defaultGetToken
  const inFlightGetRequests = new Map<string, Promise<unknown>>()

  async function request<T>(
    endpoint: string,
    init: RequestInit
  ): Promise<T> {
    const token = getToken()
    const isFormData = init.body instanceof FormData
    const method = init.method ?? 'GET'
    const startedAt = nowMs()
    let response: Response
    try {
      response = await httpFetch()(requestUrl(options.baseUrl, endpoint), {
        ...init,
        headers: {
          ...(isFormData ? {} : { 'Content-Type': 'application/json' }),
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
          ...init.headers,
        },
      })
    } catch (error) {
      logSlowHttpRequest(method, options.baseUrl, endpoint, Math.round(nowMs() - startedAt))
      throw error
    }
    logSlowHttpRequest(
      method,
      options.baseUrl,
      endpoint,
      Math.round(nowMs() - startedAt),
      response.status
    )

    if (!response.ok) throw await parseError(response)

    if (response.status === 204) {
      return null as T
    }

    return response.json() as Promise<T>
  }

  function get<T>(endpoint: string, requestOptions: HttpRequestOptions = {}): Promise<T> {
    // Model catalogs coalesce subscriptions above this layer. A caller-owned
    // signal must never cancel an unrelated anonymous GET subscriber.
    if (requestOptions.signal)
      return request<T>(endpoint, { method: 'GET', signal: requestOptions.signal })
    const token = getToken()
    const cacheKey = `${token ?? ''}:${endpoint}`
    const currentRequest = inFlightGetRequests.get(cacheKey)
    if (currentRequest) {
      return currentRequest as Promise<T>
    }

    const nextRequest = request<T>(endpoint, { method: 'GET' }).finally(() => {
      inFlightGetRequests.delete(cacheKey)
    })
    inFlightGetRequests.set(cacheKey, nextRequest)
    return nextRequest
  }

  return {
    get,
    post: (endpoint, data, requestOptions = {}) =>
      request(
        endpoint,
        {
          method: 'POST',
          signal: requestOptions.signal,
          body:
            data === undefined ? undefined : data instanceof FormData ? data : JSON.stringify(data),
        }
      ),
    put: (endpoint, data) =>
      request(endpoint, {
        method: 'PUT',
        body:
          data === undefined ? undefined : data instanceof FormData ? data : JSON.stringify(data),
      }),
    patch: (endpoint, data) =>
      request(endpoint, {
        method: 'PATCH',
        body:
          data === undefined ? undefined : data instanceof FormData ? data : JSON.stringify(data),
      }),
    delete: (endpoint, data) =>
      request(endpoint, {
        method: 'DELETE',
        body: data === undefined ? undefined : JSON.stringify(data),
      }),
  }
}
