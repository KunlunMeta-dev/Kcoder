import { describe, expect, it } from 'vitest'
import { needsPluginCredentials, pluginInstallationContext } from './pluginInstallation'
import type { PluginMarketplaceItem } from '@/types/api'

const issue = {
  code: 'installation_credentials',
  message: 'Set `GITEE_ACCESS_TOKEN` on the execution target',
}
describe('plugin installation conversation context', () => {
  it('offers assistance for missing credentials but preserves unrelated install blocks', () => {
    expect(needsPluginCredentials({ compatibility: { issues: [issue] } })).toBe(true)
    expect(
      needsPluginCredentials({
        installationAvailability: { originalInstallPolicy: 'NOT_AVAILABLE' },
        compatibility: { issues: [issue] },
      })
    ).toBe(false)

    expect(
      needsPluginCredentials({
        compatibility: {
          issues: [
            {
              code: 'installation_configuration',
              message: 'MCP environment variable `GITHUB_TOKEN` is not set',
            },
          ],
        },
      })
    ).toBe(true)
    expect(
      needsPluginCredentials({
        compatibility: { issues: [issue, { code: 'installation_package_integrity' }] },
      })
    ).toBe(false)
    expect(
      needsPluginCredentials({
        compatibility: {
          issues: [{ code: 'installation_configuration', message: 'Invalid MCP transport' }],
        },
      })
    ).toBe(false)
  })
  it('carries exact source identity and target without forwarding credential headers', () => {
    const item = {
      id: 'gitee@trae-remote-official',
      name: 'gitee',
      version: '0.0.3',
      manifest: {
        source: {
          type: 'trae',
          id: 'package-id',
          version: '0.0.3',
          headers: { Authorization: 'private-value' },
        },
        compatibility: { issues: [issue] },
      },
    } as PluginMarketplaceItem
    const raw = pluginInstallationContext(
      item,
      {
        id: 'trae-remote-official',
        name: 'TRAE',
        path: '/remote/catalog/marketplace.json',
        sourceUrl: 'https://example.com/catalog?token=private-value',
      },
      { deviceId: 'ssh-target', workspacePath: '/remote/work' }
    )
    const data = JSON.parse(raw)
    expect(data.source).toEqual({ type: 'trae', id: 'package-id', version: '0.0.3' })
    expect(data.marketplacePath).toBe('/remote/catalog/marketplace.json')
    expect(data.target).toBe('ssh-target')
    expect(raw).not.toContain('private-value')
    expect(raw).toContain('GITEE_ACCESS_TOKEN')
  })
})
