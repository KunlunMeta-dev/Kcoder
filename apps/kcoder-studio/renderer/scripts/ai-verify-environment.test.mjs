import { describe, expect, test } from 'vitest'
import {
  buildAiVerifyEnvironment,
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
    expect(environment.KCODER_STUDIO_APP_CONFIG_DIR).toBe('/tmp/owned-session/app-config')
    expect(environment.KCODER_STUDIO_AI_VERIFY_GATEWAY_ORIGIN).toBe('http://127.0.0.1:43210')
    for (const key of [
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

describe('buildAiVerifyEnvironment', () => {
  test('isolates Codex, executor, stdio gateway, and app preferences', () => {
    const environment = buildAiVerifyEnvironment(
      {
        PATH: '/usr/bin',
        WEGENT_EXECUTOR_APP_IPC_ADDR: '127.0.0.1:7777',
        WEGENT_EXECUTOR_APP_IPC_ADDR_FILE: '/tmp/foreign.addr',
        WEGENT_EXECUTOR_APP_IPC_SOCKET: '/tmp/legacy.sock',
        WEGENT_EXECUTOR_BINARY: '/tmp/foreign-executor',
        WEGENT_EXECUTOR_SOURCE_DIR: '/tmp/foreign-source',
        KCODER_STUDIO_EXECUTOR_SIDECAR: '/tmp/foreign-sidecar',
        KCODER_STUDIO_SHARED_EXECUTOR_HOME: '/tmp/shared-home',
      },
      {
        controlUrl: 'http://127.0.0.1:9999',
        token: 'control-token',
        codexHome: '/tmp/session/executor-home/codex',
        nativeCodexHome: '/tmp/session/native-codex',
        verifyCodexHomeInitialization: true,
        deviceId: 'device-1',
        appIdentifier: 'dev.kcoder.studio.ai-verify.test',
        executorHome: '/tmp/session/executor-home',
        sessionDirectory: '/tmp/session',
      }
    )

    expect(environment.CODEX_HOME).toBe('/tmp/session/executor-home/codex')
    expect(environment.WEGENT_CODEX_HOME).toBe('/tmp/session/executor-home/codex')
    expect(environment.KCODER_STUDIO_E2E_NATIVE_CODEX_HOME).toBe('/tmp/session/native-codex')
    expect(environment.VITE_KCODER_STUDIO_E2E_CODEX_HOME_INITIALIZATION).toBe('true')
    expect(environment.KCODER_STUDIO_APP_IDENTIFIER).toBe('dev.kcoder.studio.ai-verify.test')
    expect(environment.DEVICE_SESSION_GATEWAY_HOST).toBe('127.0.0.1')
    expect(environment.DEVICE_SESSION_GATEWAY_PORT).toBe('0')
    expect(environment.WEGENT_EXECUTOR_HOME).toBe('/tmp/session/executor-home')
    expect(environment.WEGENT_EXECUTOR_DEV_RELOAD).toBe('0')
    expect(environment.WEGENT_EXECUTOR_PROJECTS_DIR).toBe(
      '/tmp/session/executor-home/workspace/projects'
    )
    expect(environment.KCODER_STUDIO_EXECUTOR_ISOLATION_OVERRIDE).toBe('true')
    expect(environment.KCODER_STUDIO_DISABLE_BACKGROUND_THROTTLING).toBe('1')
    expect(environment.WEGENT_EXECUTOR_APP_IPC_ADDR).toBeUndefined()
    expect(environment.WEGENT_EXECUTOR_APP_IPC_ADDR_FILE).toBeUndefined()
    expect(environment.WEGENT_EXECUTOR_APP_IPC_SOCKET).toBeUndefined()
    expect(environment.WEGENT_EXECUTOR_BINARY).toBeUndefined()
    expect(environment.WEGENT_EXECUTOR_SOURCE_DIR).toBeUndefined()
    expect(environment.KCODER_STUDIO_EXECUTOR_SIDECAR).toBeUndefined()
    expect(environment.KCODER_STUDIO_SHARED_EXECUTOR_HOME).toBeUndefined()
    expect(environment.KCODER_STUDIO_APP_CONFIG_DIR).toBe('/tmp/session/app-config')
    expect(environment.PATH).toBe('/usr/bin')
  })
})
