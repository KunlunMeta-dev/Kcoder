import { expect, test } from 'vitest'
import type { GatewayServer } from './gatewayRpc'
import { playwrightPresetAvailability, playwrightPresetConfig } from './mcpPresets'

const local = {
  id: 'local',
  label: 'This computer',
  description: '',
  runtime: 'kcoder',
  transport: 'local',
  localMcpPresets: {
    version: 1,
    playwright: { command: 'playwright-mcp', defaultBrowser: 'chrome', outputDirectory: '/home/u/.studio/skill-runtime/playwright-mcp-output' },
  },
} satisfies GatewayServer

test('writes the bundled launcher with an isolated profile and a private output directory', () => {
  const availability = playwrightPresetAvailability(local)
  expect(availability.kind).toBe('available')
  if (availability.kind !== 'available') return
  expect(playwrightPresetConfig(availability.facts, 'msedge')).toEqual({
    name: 'playwright',
    transport: 'stdio',
    command: 'playwright-mcp',
    args: [
      '--browser', 'msedge', '--isolated',
      '--output-dir', '/home/u/.studio/skill-runtime/playwright-mcp-output',
      '--output-max-size', '268435456',
    ],
  })
})

test('remote and account-isolated targets are unsupported; missing or malformed launcher facts are unavailable', () => {
  expect(playwrightPresetAvailability(null).kind).toBe('unsupportedTarget')
  expect(playwrightPresetAvailability({ ...local, transport: 'ssh' }).kind).toBe('unsupportedTarget')
  expect(
    playwrightPresetAvailability({ ...local, security: { identity: { mode: 'kcoder-account' } } }).kind
  ).toBe('unsupportedTarget')
  expect(playwrightPresetAvailability({ ...local, localMcpPresets: undefined }).kind).toBe('runtimeUnavailable')
  for (const playwright of [
    { command: 'sh', defaultBrowser: 'chrome', outputDirectory: '/out' },
    { command: 'playwright-mcp', defaultBrowser: 'firefox', outputDirectory: '/out' },
    { command: 'playwright-mcp', defaultBrowser: 'chrome', outputDirectory: 'relative/out' },
    { command: 'playwright-mcp', defaultBrowser: 'chrome', outputDirectory: '/out\n--devtools' },
  ]) {
    expect(playwrightPresetAvailability({ ...local, localMcpPresets: { version: 1, playwright } }).kind).toBe(
      'runtimeUnavailable'
    )
  }
  const windows = playwrightPresetAvailability({
    ...local,
    localMcpPresets: {
      version: 1,
      playwright: { command: 'playwright-mcp.cmd', defaultBrowser: 'msedge', outputDirectory: 'C:\\Users\\u\\out' },
    },
  })
  expect(windows).toEqual({
    kind: 'available',
    facts: { command: 'playwright-mcp.cmd', defaultBrowser: 'msedge', outputDirectory: 'C:\\Users\\u\\out' },
  })
})
