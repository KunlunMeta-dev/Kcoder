import { describe, expect, it } from 'vitest'
import { notifyAccountContextChange } from '@/kcoder/accountContextEvents'
import { recallMarketplace, rememberMarketplace } from './marketplaceSelection'

describe('marketplace selection lifetime', () => {
  it('retains navigation selection independently for each target and workspace', () => {
    rememberMarketplace('host-a', '/project', 'local:trae')
    rememberMarketplace('host-b', '/project', 'local:qoder')
    expect(recallMarketplace('host-a', '/project')).toBe('local:trae')
    expect(recallMarketplace('host-b', '/project')).toBe('local:qoder')
    expect(recallMarketplace('host-a', '/another')).toBe('')
  })
  it('clears affected selections when an account changes', () => {
    rememberMarketplace('account-host', '/project', 'local:trae')
    rememberMarketplace('other-host', '/project', 'local:qoder')
    notifyAccountContextChange('account-host')
    expect(recallMarketplace('account-host', '/project')).toBe('')
    expect(recallMarketplace('other-host', '/project')).toBe('local:qoder')
  })
})
