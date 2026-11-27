import { describe, expect, test } from 'vitest'
import {
  buildAiVerifyGatewayEnvironment,
  validateAiVerifyGatewayOrigin,
} from './ai-verify-environment.mjs'

describe('Gateway verification trust boundary', () => {
  test('accepts only an explicit canonical IPv4 loopback origin with an assigned port', () => {
    expect(validateAiVerifyGatewayOrigin('http://127.0.0.1:43210')).toBe('http://127.0.0.1:43210')
  })

  test.each([
    'https://127.0.0.1:43210',
    'http://localhost:43210',
    'http://127.1:43210',
    'http://2130706433:43210',
    'http://127.0.0.1',
    'http://127.0.0.1:0',
    'http://127.0.0.1:65536',
    'http://127.0.0.1:43210/',
    'http://127.0.0.1:43210/redirect',
    'http://127.0.0.1:43210?token=secret',
    'http://127.0.0.1:43210#secret',
    'http://user:secret@127.0.0.1:43210',
    'http://127.0.0.1.attacker.example:43210',
    'http://203.0.113.7:43210',
    'file:///tmp/index.html',
  ])('rejects a non-canonical or untrusted origin without echoing it: %s', origin => {
    expect(() => validateAiVerifyGatewayOrigin(origin)).toThrow(
      'Gateway verification requires an owned http://127.0.0.1:<port> origin'
    )
  })

  test('does not inherit personal credentials, loaders, runtime or application settings', () => {
    const environment = buildAiVerifyGatewayEnvironment(
      {
        PATH: '/usr/bin',
        DISPLAY: ':99',
        HOME: '/personal',
        OPENAI_API_KEY: 'personal-secret',
        NODE_OPTIONS: '--require=/personal/hook.cjs',
        LD_PRELOAD: '/personal/hook.so',
        KCODER_HOME: '/personal/kcoder',
        KCODER_STUDIO_AUTH_TOKEN: 'personal-token',
        KCODER_STUDIO_EXECUTOR_SIDECAR: '/personal/sidecar',
        VITE_KCODER_STUDIO_E2E_CLOUD_TOKEN: 'personal-cloud-token',
      },
      {
        gatewayOrigin: 'http://127.0.0.1:43210',
        controlUrl: 'http://127.0.0.1:43211',
        token: 'session-control-token',
        sessionDirectory: '/tmp/owned-session',
      }
    )
    expect(environment.PATH).toBe('/usr/bin')
    expect(environment.DISPLAY).toBe(':99')
    expect(environment.HOME).toBe('/tmp/owned-session/native-home')
    for (const key of [
      'KCODER_STUDIO_AI_VERIFY_CONTROL_TOKEN',
      'KCODER_STUDIO_AI_VERIFY_CONTROL_URL',
      'OPENAI_API_KEY',
      'NODE_OPTIONS',
      'LD_PRELOAD',
      'KCODER_STUDIO_AUTH_TOKEN',
      'KCODER_STUDIO_EXECUTOR_SIDECAR',
      'VITE_KCODER_STUDIO_E2E_CLOUD_TOKEN',
    ])
      expect(environment[key]).toBeUndefined()
    expect(JSON.stringify(environment)).not.toContain('/personal')
  })
})
