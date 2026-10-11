import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

export const PLUGIN_MARKETPLACE_NAME = 'desktop-e2e-marketplace'
export const PLUGIN_NAME = 'desktop-e2e-plugin'
export const PLUGIN_DISPLAY_NAME = 'Desktop E2E Plugin'

export async function createPluginMarketplaceFixture(root) {
  const marketplaceManifestDir = join(root, '.agents', 'plugins')
  const pluginRoot = join(root, 'plugins', PLUGIN_NAME)
  await Promise.all([
    mkdir(marketplaceManifestDir, { recursive: true }),
    mkdir(join(pluginRoot, '.codex-plugin'), { recursive: true }),
    mkdir(join(pluginRoot, 'skills', 'desktop-e2e-skill'), { recursive: true }),
  ])
  await Promise.all([
    writeFile(
      join(marketplaceManifestDir, 'marketplace.json'),
      `${JSON.stringify(
        {
          name: PLUGIN_MARKETPLACE_NAME,
          interface: { displayName: 'Desktop E2E Marketplace' },
          plugins: [
            { name: PLUGIN_NAME, source: { source: 'local', path: `./plugins/${PLUGIN_NAME}` } },
          ],
        },
        null,
        2
      )}\n`
    ),
    writeFile(
      join(pluginRoot, '.codex-plugin', 'plugin.json'),
      `${JSON.stringify(
        {
          name: PLUGIN_NAME,
          interface: {
            displayName: PLUGIN_DISPLAY_NAME,
            shortDescription: 'Exercises the real app plugin lifecycle',
          },
        },
        null,
        2
      )}\n`
    ),
    writeFile(
      join(pluginRoot, 'skills', 'desktop-e2e-skill', 'SKILL.md'),
      `---\nname: desktop-e2e-skill\ndescription: Verifies the installed plugin can be used in chat.\n---\n\nUse this skill to verify the desktop plugin flow.\n`
    ),
  ])
}
