import { fetch as tauriFetch } from '@tauri-apps/plugin-http'
import { shouldUseTauriFetch } from '@/api/http'
import {
  buildLocalModelRequestUrl,
  defaultLocalModelToolProfile,
  normalizeLocalModelApiFormat,
  normalizeLocalModelId,
  type LocalModelApiFormat,
  type LocalModelToolProfile,
} from './localModelSettings'

const DEFAULT_TEST_TIMEOUT_MS = 15_000
const DUMMY_API_KEY = 'dummy'

export interface TestLocalModelConnectionInput {
  baseUrl: string
  apiFormat?: LocalModelApiFormat | null
  requestPath?: string | null
  modelId: string
  toolProfile?: LocalModelToolProfile | null
  apiKey?: string | null
}

export interface TestLocalModelConnectionOptions {
  fetcher?: typeof fetch
  timeoutMs?: number
}

export interface TestLocalModelConnectionResult {
  status: number
  toolCalling: true
}

const PROBE_TOOL_NAME = 'wework_capability_probe'

function testRequestBody(
  apiFormat: LocalModelApiFormat,
  model: string,
  toolProfile: LocalModelToolProfile
): Record<string, unknown> {
  if (apiFormat === 'anthropic-messages') {
    return {
      model,
      messages: [{ role: 'user', content: 'Call the capability probe with value PING.' }],
      max_tokens: 64,
      stream: false,
      tools: [
        {
          name: PROBE_TOOL_NAME,
          description: 'Return the exact probe value.',
          input_schema: {
            type: 'object',
            properties: { input: { type: 'string' } },
            required: ['input'],
          },
        },
      ],
    }
  }
  if (apiFormat === 'openai-chat-completions') {
    return {
      model,
      messages: [{ role: 'user', content: 'Call the capability probe with value PING.' }],
      max_tokens: 64,
      stream: false,
      tools: [
        {
          type: 'function',
          function: {
            name: PROBE_TOOL_NAME,
            description: 'Return the exact probe value.',
            parameters: {
              type: 'object',
              properties: { input: { type: 'string' } },
              required: ['input'],
            },
          },
        },
      ],
    }
  }
  const custom = toolProfile === 'custom'
  return {
    model,
    input: 'Call the capability probe with value PING.',
    max_output_tokens: 64,
    stream: false,
    store: false,
    tools: custom
      ? [
          {
            type: 'custom',
            name: PROBE_TOOL_NAME,
            description: 'Return the exact probe value.',
            format: { type: 'grammar', syntax: 'lark', definition: 'start: "PING"' },
          },
        ]
      : [
          {
            type: 'function',
            name: PROBE_TOOL_NAME,
            description: 'Return the exact probe value.',
            parameters: {
              type: 'object',
              properties: { input: { type: 'string' } },
              required: ['input'],
            },
          },
        ],
  }
}

function hasProbeToolCall(apiFormat: LocalModelApiFormat, body: unknown): boolean {
  const record = (value: unknown): Record<string, unknown> | null =>
    value !== null && typeof value === 'object' ? (value as Record<string, unknown>) : null
  const array = (value: unknown): unknown[] => (Array.isArray(value) ? value : [])
  const value = record(body)
  if (!value) return false
  if (apiFormat === 'anthropic-messages') {
    return array(value.content).some(item => {
      const candidate = record(item)
      return candidate?.type === 'tool_use' && candidate.name === PROBE_TOOL_NAME
    })
  }
  if (apiFormat === 'openai-chat-completions') {
    return array(value.choices).some(choice => {
      const message = record(record(choice)?.message)
      return array(message?.tool_calls).some(call => {
        const fn = record(record(call)?.function)
        return fn?.name === PROBE_TOOL_NAME
      })
    })
  }
  return array(value.output).some(item => {
    const candidate = record(item)
    return (
      (candidate?.type === 'custom_tool_call' || candidate?.type === 'function_call') &&
      candidate.name === PROBE_TOOL_NAME
    )
  })
}

function defaultFetcher(): typeof fetch {
  return shouldUseTauriFetch() ? (tauriFetch as typeof fetch) : globalThis.fetch.bind(globalThis)
}

export type LocalModelConnectionErrorKind =
  | 'authentication'
  | 'permission'
  | 'rate_limit'
  | 'overloaded'
  | 'model'
  | 'timeout'
  | 'network'
  | 'protocol'

export class LocalModelConnectionError extends Error {
  readonly kind: LocalModelConnectionErrorKind
  readonly status?: number
  constructor(kind: LocalModelConnectionErrorKind, message: string, status?: number) {
    super(message)
    this.kind = kind
    this.status = status
    this.name = 'LocalModelConnectionError'
  }
}

function httpError(status: number): LocalModelConnectionError {
  const category: [LocalModelConnectionErrorKind, string] =
    status === 401
      ? ['authentication', 'Authentication failed']
      : status === 403
        ? ['permission', 'Access denied']
        : status === 429
          ? ['rate_limit', 'Rate limited']
          : status === 529
            ? ['overloaded', 'Provider overloaded']
            : status === 404
              ? ['model', 'Model unavailable']
              : ['protocol', 'Unexpected API response']
  // Upstream bodies and status text can echo submitted credentials.
  return new LocalModelConnectionError(category[0], `HTTP ${status}: ${category[1]}`, status)
}

export async function testLocalModelConnection(
  input: TestLocalModelConnectionInput,
  options: TestLocalModelConnectionOptions = {}
): Promise<TestLocalModelConnectionResult> {
  const apiFormat = normalizeLocalModelApiFormat(input.apiFormat)
  const requestUrl = buildLocalModelRequestUrl(input.baseUrl, input.requestPath, apiFormat)
  const modelId = normalizeLocalModelId(input.modelId)
  const apiKey = input.apiKey?.trim() || DUMMY_API_KEY
  const toolProfile = input.toolProfile ?? defaultLocalModelToolProfile(apiFormat)
  const fetcher = options.fetcher ?? defaultFetcher()
  const controller = new AbortController()
  const timeout = window.setTimeout(
    () => controller.abort(),
    options.timeoutMs ?? DEFAULT_TEST_TIMEOUT_MS
  )

  try {
    const response = await fetcher(requestUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
        ...(apiFormat === 'anthropic-messages'
          ? { 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' }
          : {}),
      },
      body: JSON.stringify(testRequestBody(apiFormat, modelId, toolProfile)),
      signal: controller.signal,
    })

    if (!response.ok) {
      throw httpError(response.status)
    }

    let body: unknown
    try {
      body = await response.json()
    } catch {
      throw new LocalModelConnectionError('protocol', 'Model returned a non-JSON response body')
    }
    if (!hasProbeToolCall(apiFormat, body)) {
      throw new LocalModelConnectionError(
        'protocol',
        'Model did not return the required capability probe tool call'
      )
    }
    return { status: response.status, toolCalling: true }
  } catch (error) {
    if (error instanceof DOMException && error.name === 'AbortError') {
      throw new LocalModelConnectionError('timeout', 'Model test timed out')
    }
    if (error instanceof LocalModelConnectionError) throw error
    throw new LocalModelConnectionError('network', 'Model connection failed')
  } finally {
    window.clearTimeout(timeout)
  }
}
