import type { ExtensionsInventoryResult } from './extensionsInventory'

/** Built-in lark-doc shadows the TRAE plugin copy; the plugin provides part of the family. */
export function larkInventory(
  overrides: Partial<ExtensionsInventoryResult> = {}
): ExtensionsInventoryResult {
  return {
    items: [
      {
        id: 'skill:bundled::lark-doc',
        kind: 'skill',
        name: 'lark-doc',
        layer: 'bundled',
        path: '~/.kcoder/skills/.builtin/lark-doc/SKILL.md',
        enabled: true,
        effective: true,
        shadows: [
          {
            layer: 'plugin',
            ownerPluginId: 'lark@trae',
            path: '~/.kcoder/plugins/cache/lark/skills/lark-doc/SKILL.md',
          },
        ],
        upstream: { repository: 'https://github.com/larksuite/cli', ref: 'v1.0.100' },
        family: 'lark',
      },
      {
        id: 'skill:plugin:lark@trae:lark-doc',
        kind: 'skill',
        name: 'lark-doc',
        layer: 'plugin',
        ownerPluginId: 'lark@trae',
        marketplaceId: 'trae',
        path: '~/.kcoder/plugins/cache/lark/skills/lark-doc/SKILL.md',
        enabled: true,
        effective: false,
        shadowedBy: { layer: 'bundled', path: '~/.kcoder/skills/.builtin/lark-doc/SKILL.md' },
        upstream: { repository: 'https://github.com/larksuite/cli', ref: 'v1.0.8' },
        family: 'lark',
      },
      {
        id: 'skill:project::review',
        kind: 'skill',
        name: 'review',
        layer: 'project',
        path: '/work/.kcoder/skills/review/SKILL.md',
        enabled: true,
        effective: true,
      },
      {
        id: 'plugin:plugin:lark@trae:Lark',
        kind: 'plugin',
        name: 'Lark',
        layer: 'plugin',
        ownerPluginId: 'lark@trae',
        enabled: true,
        effective: true,
        count: 3,
      },
      {
        id: 'mcp_server:plugin:lark@trae:plugin.lark@trae.lark',
        kind: 'mcp_server',
        name: 'plugin.lark@trae.lark',
        layer: 'plugin',
        ownerPluginId: 'lark@trae',
        enabled: false,
        disabledBy: 'policy',
        effective: false,
        detail: 'stdio',
      },
      {
        id: 'hook:user::PreToolUse',
        kind: 'hook',
        name: 'PreToolUse',
        layer: 'user',
        path: '~/.kcoder/settings.json',
        enabled: true,
        effective: true,
        detail: 'PreToolUse',
        count: 2,
      },
    ],
    conflicts: [
      {
        kind: 'skill',
        reason: 'same_name',
        name: 'lark-doc',
        effective: { layer: 'bundled', path: '~/.kcoder/skills/.builtin/lark-doc/SKILL.md' },
        shadowed: [
          {
            layer: 'plugin',
            ownerPluginId: 'lark@trae',
            path: '~/.kcoder/plugins/cache/lark/skills/lark-doc/SKILL.md',
          },
        ],
        sameUpstream: true,
      },
      {
        kind: 'skill',
        reason: 'mixed_family',
        name: 'lark',
        pluginId: 'lark@trae',
        provided: ['lark-doc'],
        missing: ['lark-im'],
      },
    ],
    hookIssues: [
      {
        layer: 'user',
        path: '~/.kcoder/settings.json',
        location: 'hooks.PreToolUse[1].hooks[0]',
        event: 'PreToolUse',
        severity: 'error',
        message: 'Unsupported hook type',
      },
    ],
    skillPreference: { preferPluginSkills: {}, preferPlugins: [] },
    skillPreferenceRevision: 'rev-1',
    binariesIncluded: false,
    appliesToNewConversations: true,
    ...overrides,
  }
}

export function binaryInventory(): ExtensionsInventoryResult {
  return larkInventory({
    binariesIncluded: true,
    items: [
      ...larkInventory().items,
      {
        id: 'binary:external::lark-cli',
        kind: 'binary',
        name: 'lark-cli',
        layer: 'external',
        path: '/usr/local/bin/lark-cli',
        enabled: true,
        effective: true,
        bundled: false,
        version: '1.0.8',
        detail: 'Feishu CLI',
        shadows: [{ layer: 'external', path: '~/Studio/resources/lark-cli/lark-cli' }],
      },
      {
        id: 'binary:external::lark-cli#2',
        kind: 'binary',
        name: 'lark-cli',
        layer: 'external',
        path: '~/Studio/resources/lark-cli/lark-cli',
        enabled: true,
        effective: false,
        bundled: false,
        detail: 'Feishu CLI',
        shadowedBy: { layer: 'external', path: '/usr/local/bin/lark-cli' },
      },
    ],
    conflicts: [
      ...larkInventory().conflicts,
      {
        kind: 'binary',
        reason: 'multiple_binaries',
        name: 'lark-cli',
        effective: { layer: 'external', path: '/usr/local/bin/lark-cli' },
        shadowed: [{ layer: 'external', path: '~/Studio/resources/lark-cli/lark-cli' }],
      },
      {
        kind: 'binary',
        reason: 'version_mismatch',
        name: 'lark-cli',
        effective: { layer: 'external', path: '/usr/local/bin/lark-cli' },
        sameUpstream: true,
        provided: ['1.0.8'],
        missing: ['1.0.100'],
      },
    ],
  })
}
