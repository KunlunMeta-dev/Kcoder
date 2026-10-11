import { render, screen } from '@testing-library/react'
import { convertFileSrc } from '@tauri-apps/api/core'
import userEvent from '@testing-library/user-event'
import { describe, expect, test, vi } from 'vitest'
import '@/i18n'

vi.mock('@tauri-apps/api/core', () => ({
  convertFileSrc: vi.fn((path: string) => `asset://localhost/${path.replace(/^\/+/, '')}`),
}))
import {
  InstalledMcpRow,
  InstalledPluginRow,
  InstalledSkillRow,
  type InstalledPluginItem,
  type InstalledSkillItem,
} from './PluginManagementRows'
import type {
  InstalledMCP,
  InstalledMCPSource,
  InstalledPlugin,
  InstalledPluginSource,
  InstalledSkill,
  InstalledSkillSource,
  MCPInstallState,
  PluginInstallState,
  SystemSkillInstallState,
} from '@/types/api'

/**
 * X1 asks that the installed list explain a plugin's state rather than reduce
 * it to "present or absent". These tests pin the two pieces of that contract
 * the row is responsible for: where a plugin came from, and whether its install
 * state is anything other than healthy.
 */

function pluginSource(overrides: Partial<InstalledPluginSource> = {}): InstalledPluginSource {
  return {
    type: 'marketplace',
    providerKey: 'openai-bundled',
    pluginKey: 'alpha',
    marketplace: 'OpenAI Bundled',
    ...overrides,
  }
}

function installedPlugin(raw: {
  installState?: PluginInstallState
  source?: InstalledPluginSource
  logo?: string | null
  brandColor?: string | null
}): InstalledPlugin {
  return {
    apiVersion: 'agent.wecode.io/v1',
    kind: 'InstalledPlugin',
    metadata: { name: 'alpha', labels: { id: 'alpha' } },
    spec: {
      source: raw.source ?? pluginSource(),
      displayName: 'Alpha',
      description: 'Alpha plugin',
      version: '1.2.3',
      installState: raw.installState ?? 'installed',
      enabled: true,
      componentStates: {},
      manifest: { name: 'alpha' },
      components: {
        skills: [],
        commands: [],
        agents: [],
        hooks: [],
        mcps: [],
        lsps: [],
        monitors: [],
        bins: [],
      },
      interface:
        raw.logo || raw.brandColor
          ? { logo: raw.logo ?? null, brandColor: raw.brandColor ?? null }
          : null,
    },
    status: { state: 'enabled' },
  }
}

function installedSkill(raw: {
  installState?: SystemSkillInstallState
  source?: InstalledSkillSource
}): InstalledSkill {
  return {
    apiVersion: 'agent.wecode.io/v1',
    kind: 'InstalledSkill',
    metadata: { name: 'skill' },
    spec: {
      source: raw.source ?? { type: 'system', skillKey: 'skill' },
      displayName: 'Skill',
      description: 'Skill description',
      installState: raw.installState ?? 'installed',
      enabled: true,
    },
    status: { state: 'enabled' },
  }
}

function skillRow(raw: Parameters<typeof installedSkill>[0] = {}): InstalledSkillItem {
  return {
    id: 42,
    name: 'Skill',
    description: 'Skill description',
    enabled: true,
    sourceType: 'system',
    raw: installedSkill(raw),
  }
}

function installedMcp(raw: {
  installState?: MCPInstallState
  source?: InstalledMCPSource
}): InstalledMCP {
  return {
    apiVersion: 'agent.wecode.io/v1',
    kind: 'InstalledMCP',
    metadata: { name: 'server' },
    spec: {
      source: raw.source ?? { type: 'custom', serverKey: 'server' },
      displayName: 'Server',
      description: 'MCP server',
      server: { type: 'http', url: 'https://example.test/mcp' },
      installState: raw.installState ?? 'installed',
      enabled: true,
    },
    status: { state: 'enabled' },
  }
}

function pluginRow(raw: Parameters<typeof installedPlugin>[0] = {}): InstalledPluginItem {
  return {
    id: 'alpha',
    name: 'Alpha',
    description: 'Alpha plugin',
    enabled: true,
    version: '1.2.3',
    componentCounts: { skills: 2 },
    raw: installedPlugin(raw),
  }
}

describe('InstalledPluginRow icon', () => {
  test('renders the icon the plugin declares instead of a generic glyph', () => {
    render(
      <InstalledPluginRow
        plugin={pluginRow({ logo: '/plugins/alpha/logo.png' })}
        onToggle={vi.fn()}
        onUninstall={vi.fn()}
      />
    )

    const tile = screen.getByTestId('installed-plugin-icon-alpha')
    const image = tile.querySelector('img')
    expect(image).not.toBeNull()
    expect(image).toHaveAttribute('src', expect.stringContaining('logo.png'))
    expect(convertFileSrc).toHaveBeenCalled()
  })

  test('falls back to a glyph when the plugin declares no icon', () => {
    render(<InstalledPluginRow plugin={pluginRow()} onToggle={vi.fn()} onUninstall={vi.fn()} />)

    const tile = screen.getByTestId('installed-plugin-icon-alpha')
    expect(tile.querySelector('img')).toBeNull()
    expect(tile.querySelector('svg')).not.toBeNull()
  })

  test('lets a declared brand colour tint the tile', () => {
    render(
      <InstalledPluginRow
        plugin={pluginRow({ brandColor: '#ff8800' })}
        onToggle={vi.fn()}
        onUninstall={vi.fn()}
      />
    )

    expect(screen.getByTestId('installed-plugin-icon-alpha')).toHaveStyle({
      backgroundColor: '#ff8800',
    })
  })

  test('keeps the neutral tile when no brand colour is declared', () => {
    render(<InstalledPluginRow plugin={pluginRow()} onToggle={vi.fn()} onUninstall={vi.fn()} />)

    expect(screen.getByTestId('installed-plugin-icon-alpha')).toHaveClass('bg-surface')
  })
})

describe('InstalledPluginRow', () => {
  test('names the marketplace a plugin came from', () => {
    render(<InstalledPluginRow plugin={pluginRow()} onToggle={vi.fn()} onUninstall={vi.fn()} />)

    const origin = screen.getByTestId('installed-plugin-origin-alpha')
    expect(origin).toHaveAttribute('data-source-type', 'marketplace')
    expect(origin).toHaveTextContent('OpenAI Bundled')
  })

  test('falls back to the provider key when the marketplace has no name', () => {
    render(
      <InstalledPluginRow
        plugin={pluginRow({ source: pluginSource({ marketplace: null }) })}
        onToggle={vi.fn()}
        onUninstall={vi.fn()}
      />
    )

    expect(screen.getByTestId('installed-plugin-origin-alpha')).toHaveTextContent('openai-bundled')
  })

  test('distinguishes uploaded and local sources without implying a marketplace', () => {
    const { unmount } = render(
      <InstalledPluginRow
        plugin={pluginRow({ source: pluginSource({ type: 'upload' }) })}
        onToggle={vi.fn()}
        onUninstall={vi.fn()}
      />
    )
    expect(screen.getByTestId('installed-plugin-origin-alpha')).toHaveAttribute(
      'data-source-type',
      'upload'
    )
    unmount()

    render(
      <InstalledPluginRow
        plugin={pluginRow({ source: pluginSource({ type: 'local' }) })}
        onToggle={vi.fn()}
        onUninstall={vi.fn()}
      />
    )
    expect(screen.getByTestId('installed-plugin-origin-alpha')).toHaveAttribute(
      'data-source-type',
      'local'
    )
  })

  test('omits the origin chip rather than crashing when the payload has no source', () => {
    const plugin = pluginRow()
    // Simulates a malformed payload reaching the row.
    delete (plugin.raw.spec as { source?: InstalledPluginSource }).source

    render(<InstalledPluginRow plugin={plugin} onToggle={vi.fn()} onUninstall={vi.fn()} />)

    expect(screen.queryByTestId('installed-plugin-origin-alpha')).not.toBeInTheDocument()
    expect(screen.getByTestId('installed-plugin-row-alpha')).toBeInTheDocument()
  })

  test.each(['update_available', 'unavailable', 'failed', 'uninstalled'] as const)(
    'surfaces the %s state instead of looking like a healthy install',
    state => {
      render(
        <InstalledPluginRow
          plugin={pluginRow({ installState: state })}
          onToggle={vi.fn()}
          onUninstall={vi.fn()}
        />
      )

      const chip = screen.getByTestId('installed-plugin-state-alpha')
      expect(chip).toHaveAttribute('data-install-state', state)
      // DESIGN.md 4.2: status always carries a non-colour cue.
      expect(chip).toHaveTextContent(/\S/)
    }
  )

  test('shows no state chip for a healthy install', () => {
    render(
      <InstalledPluginRow
        plugin={pluginRow({ installState: 'installed' })}
        onToggle={vi.fn()}
        onUninstall={vi.fn()}
      />
    )

    expect(screen.queryByTestId('installed-plugin-state-alpha')).not.toBeInTheDocument()
  })

  test('toggling the switch does not also activate the row', async () => {
    const onToggle = vi.fn()
    const onOpen = vi.fn()
    render(
      <InstalledPluginRow
        plugin={pluginRow()}
        onToggle={onToggle}
        onUninstall={vi.fn()}
        onOpen={onOpen}
      />
    )

    await userEvent.click(screen.getByTestId('installed-plugin-toggle-alpha'))

    expect(onToggle).toHaveBeenCalledTimes(1)
    expect(onOpen).not.toHaveBeenCalled()
  })
})

describe('installed row switches', () => {
  test('drive the shared switch and report the state it moved to', async () => {
    const onToggle = vi.fn()
    render(<InstalledSkillRow skill={skillRow()} onToggle={onToggle} onUninstall={vi.fn()} />)

    const toggle = screen.getByTestId('installed-skill-toggle-42')
    expect(toggle).toHaveAttribute('role', 'switch')
    expect(toggle).toHaveAttribute('aria-checked', 'true')
    expect(toggle).toHaveAttribute('data-state', 'checked')

    await userEvent.click(toggle)

    expect(onToggle).toHaveBeenCalledTimes(1)
  })

  test('anchors the knob inside the track', () => {
    render(
      <InstalledMcpRow
        mcp={mcpRow()}
        onToggle={vi.fn()}
        onUninstall={vi.fn()}
      />
    )

    // Selector preserved from the previous inline switch implementation.
    const knob = screen.getByTestId('installed-mcp-toggle-7').querySelector('span')
    expect(knob).toHaveClass('left-1')
  })
})

describe('InstalledSkillRow state and origin', () => {
  test('reports a git-installed skill as coming from git, not as a system skill', () => {
    // `sourceType` collapses git/market into `system`, so the row must read the
    // richer source rather than that field.
    render(
      <InstalledSkillRow
        skill={skillRow({ source: { type: 'git', skillKey: 's' } })}
        onToggle={vi.fn()}
        onUninstall={vi.fn()}
      />
    )

    expect(screen.getByTestId('installed-skill-origin-42')).toHaveAttribute(
      'data-source-type',
      'git'
    )
  })

  test('names the provider for a marketplace-installed skill', () => {
    render(
      <InstalledSkillRow
        skill={skillRow({ source: { type: 'market', providerKey: 'openai', skillKey: 's' } })}
        onToggle={vi.fn()}
        onUninstall={vi.fn()}
      />
    )

    const origin = screen.getByTestId('installed-skill-origin-42')
    expect(origin).toHaveAttribute('data-source-type', 'market')
    expect(origin).toHaveTextContent('openai')
  })

  test('surfaces a non-healthy install state', () => {
    render(
      <InstalledSkillRow
        skill={skillRow({ installState: 'update_available' })}
        onToggle={vi.fn()}
        onUninstall={vi.fn()}
      />
    )

    expect(screen.getByTestId('installed-skill-state-42')).toHaveAttribute(
      'data-install-state',
      'update_available'
    )
  })

  test('shows no state chip for a healthy install', () => {
    render(<InstalledSkillRow skill={skillRow()} onToggle={vi.fn()} onUninstall={vi.fn()} />)

    expect(screen.queryByTestId('installed-skill-state-42')).not.toBeInTheDocument()
  })
})

function mcpRow(raw: Parameters<typeof installedMcp>[0] = {}): InstalledMcpItem {
  return {
    id: 7,
    name: 'Server',
    description: 'MCP server',
    enabled: true,
    serverType: 'http',
    raw: installedMcp(raw),
  }
}

describe('InstalledMcpRow state and origin', () => {
  test('names the provider an MCP server came from', () => {
    render(
      <InstalledMcpRow
        mcp={mcpRow({ source: { type: 'provider', providerKey: 'openai', serverKey: 's' } })}
        onToggle={vi.fn()}
        onUninstall={vi.fn()}
      />
    )

    const origin = screen.getByTestId('installed-mcp-origin-7')
    expect(origin).toHaveAttribute('data-source-type', 'provider')
    expect(origin).toHaveTextContent('openai')
  })

  test('marks a user-created server as custom rather than provider-supplied', () => {
    render(
      <InstalledMcpRow
        mcp={mcpRow({ source: { type: 'custom', serverKey: 's' } })}
        onToggle={vi.fn()}
        onUninstall={vi.fn()}
      />
    )

    expect(screen.getByTestId('installed-mcp-origin-7')).toHaveAttribute(
      'data-source-type',
      'custom'
    )
  })

  test('surfaces a non-healthy install state', () => {
    render(
      <InstalledMcpRow
        mcp={mcpRow({ installState: 'unavailable' })}
        onToggle={vi.fn()}
        onUninstall={vi.fn()}
      />
    )

    expect(screen.getByTestId('installed-mcp-state-7')).toHaveAttribute(
      'data-install-state',
      'unavailable'
    )
  })

  test('shows no state chip for a healthy install', () => {
    render(<InstalledMcpRow mcp={mcpRow()} onToggle={vi.fn()} onUninstall={vi.fn()} />)

    expect(screen.queryByTestId('installed-mcp-state-7')).not.toBeInTheDocument()
  })

  test('degrades to no chips when the payload cannot describe the server', () => {
    const mcp = mcpRow()
    delete (mcp as { raw?: InstalledMCP }).raw

    render(<InstalledMcpRow mcp={mcp} onToggle={vi.fn()} onUninstall={vi.fn()} />)

    expect(screen.queryByTestId('installed-mcp-origin-7')).not.toBeInTheDocument()
    expect(screen.queryByTestId('installed-mcp-state-7')).not.toBeInTheDocument()
    expect(screen.getByTestId('installed-mcp-toggle-7')).toBeInTheDocument()
  })
})
