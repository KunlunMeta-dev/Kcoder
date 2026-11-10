import '@/i18n'
import i18n from 'i18next'
import { afterEach, describe, expect, test } from 'vitest'
import { GatewayRpcError } from './gatewayRpc'
import { sessionHistoryErrorMessage } from './sessionHistoryError'

const missing = 'failed to validate bound history source: history source control directory exists but its record is missing; explicit recovery is required'

describe('session history recovery failures', () => {
  afterEach(async () => { await i18n.changeLanguage('zh-CN') })

  test('provides a localized new-conversation action without asking users to repair files', async () => {
    await i18n.changeLanguage('zh-CN')
    const error = new GatewayRpcError(missing, -32603, undefined, 'runtime-session', 'remote')
    expect(error.message).toContain('请新建会话继续')
    expect(error.message).not.toContain('source.json')
    expect(error.message).not.toContain('explicit recovery')
    expect((error.cause as Error).message).toBe(missing)
    expect(error.code).toBe(-32603)
    expect(error.operation).toBe('runtime-session')
  })

  test('also translates persisted raw sidebar errors from older runtimes', async () => {
    await i18n.changeLanguage('en')
    expect(sessionHistoryErrorMessage(missing)).toContain('Start a new conversation')
    expect(sessionHistoryErrorMessage('failed to bind history source: history source record is corrupt; explicit recovery is required'))
      .toContain('Existing conversation data will not be overwritten')
  })

  test('does not hide unrelated failures or turn an unknown outcome into a retry suggestion', () => {
    for (const message of ['history_catalog_busy', 'history source has an unfinished commit; explicit recovery is required', 'Request timed out; execution outcome is unknown', 'Permission denied']) {
      const error = new GatewayRpcError(message)
      expect(error.message).toBe(message)
      expect(error.cause).toBeUndefined()
    }
  })
})
