import { describe, expect, it } from 'vitest'
import { marketplaceBlockReason } from './plugin-availability'

describe('marketplace availability explanation', () => {
  it('exposes a localized reason without exposing credential values', () => {
    const result = marketplaceBlockReason({
      compatibility: {
        issues: [
          {
            code: 'installation_configuration',
            message: 'token=secret-value missing configuration',
          },
        ],
      },
    })
    expect(result?.key).toBe('pluginNetwork.blockedConfiguration')
    expect(result?.details).not.toContain('secret-value')
  })
  it('does not turn partial compatibility warnings into an install block', () => {
    expect(
      marketplaceBlockReason({
        compatibility: { issues: [{ code: 'model_inherited', message: 'Uses active model' }] },
      })
    ).toBeUndefined()
    expect(marketplaceBlockReason(null)).toBeUndefined()
  })
})
