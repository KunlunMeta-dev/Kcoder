import { describe, expect, test } from 'vitest'
import { parseChatError } from './chat-error'

describe('parseChatError', () => {
  test('recognizes local runtime provenance without reclassifying unrelated unsupported errors', () => {
    expect(parseChatError('Storage initialization failed', 'local_runtime_error').type).toBe('local_runtime_error')
    expect(parseChatError('PlanStore requires secure handle-relative directory I/O; this platform is unsupported').type).toBe('local_runtime_error')
    expect(parseChatError('some unsupported operation').type).toBe('generic_error')
    expect(parseChatError('model does not support images').type).toBe('llm_unsupported')
  })
  test('keeps trusted model or route failures distinct from unknown provider failures', () => {
    expect(parseChatError('HTTP 401 network quota', 'provider_error', {
      category: 'model_or_route', recovery_action: 'needs_human', retryable: false, resume_safe: false,
    })).toEqual({
      type: 'model_or_route',
      titleKey: 'assistant_error.types.model_or_route.title',
      descriptionKey: 'assistant_error.types.model_or_route.description',
    })
  })
  test.each([
    ['API status=401 type=invalid_api_key message=Invalid API key.', 'authentication_error'],
    ['API status=401 message=Check billing settings.', 'authentication_error'],
    ['API status=403 message=Access forbidden. Contact billing support.', 'forbidden'],
    ['API status=403 code=insufficient_quota message=余额不足', 'forbidden'],
    ['API Error: 401 Unauthorized', 'authentication_error'],
    ['401', 'authentication_error'],
    ['HTTP 403 Forbidden', 'forbidden'],
    ['403 Forbidden', 'forbidden'],
    ['429', 'rate_limit'],
    ['API status=429 message=Request rejected.', 'rate_limit'],
    ['API status=429 message=Check billing settings.', 'rate_limit'],
    ['API status=429 code=insufficient_quota message=Quota exceeded.', 'quota_exceeded'],
    ['API status=429 message=You exceeded your current quota.', 'quota_exceeded'],
    [
      '{"error":{"type":"authentication_error","message":"Invalid credential"}}',
      'authentication_error',
    ],
    ['{"error":{"code":"invalid_api_key","message":"Check billing"}}', 'authentication_error'],
    ['Please review billing settings.', 'generic_error'],
    ['request_id=req_401 model=model-429 request rejected', 'generic_error'],
  ])('prioritizes provider status and specific error codes: %s', (message, type) => {
    expect(parseChatError(message).type).toBe(type)
  })

  test('does not let an incorrect quota backend label override an explicit authentication status', () => {
    expect(parseChatError('API status=401 message=Invalid credential', 'quota_exceeded').type).toBe(
      'authentication_error'
    )
  })

  test.each([
    ['context_length_exceeded', 'context_length_exceeded'],
    ['quota_exceeded', 'quota_exceeded'],
    ['rate_limit', 'rate_limit'],
    ['content_filter', 'content_filter'],
    ['permission_denied', 'permission_denied'],
    ['model_unavailable', 'llm_error'],
  ])('uses backend error type %s before keyword matching', (errorType, normalizedType) => {
    expect(parseChatError('raw backend message', errorType).type).toBe(normalizedType)
  })

  test('extracts backend error codes from JSON-shaped messages', () => {
    const parsed = parseChatError(
      'Task failed: {"error_code":"payload_too_large","message":"too much data"}'
    )

    expect(parsed.type).toBe('payload_too_large')
    expect(parsed.titleKey).toBe('assistant_error.types.payload_too_large.title')
  })

  test.each([
    ['maximum context length exceeded', 'context_length_exceeded'],
    ['data_inspection_failed: risky content', 'content_filter'],
    ['image size exceeds limit', 'image_too_large'],
    ['invalid role: user', 'invalid_role'],
    ['only claude models are supported', 'model_protocol_error'],
    ['out of memory', 'container_oom'],
    ['peer closed connection without response', 'network_error'],
    ['请求超时，请稍后重试', 'timeout_error'],
    [
      'API Error: 400 {"error":{"message":"模型 deepseek-v3.1 不支持 Anthropic 协议"}}',
      'model_protocol_error',
    ],
  ])('classifies %s as %s', (message, type) => {
    expect(parseChatError(message).type).toBe(type)
  })
})
