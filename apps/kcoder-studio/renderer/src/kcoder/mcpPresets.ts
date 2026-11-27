import type { GatewayServer } from './gatewayRpc'

/** Configured name of the browser automation preset; skills refer to its `mcp__playwright__*` tools. */
export const PLAYWRIGHT_PRESET_NAME = 'playwright'

export const PLAYWRIGHT_BROWSERS = ['chrome', 'msedge'] as const
export type PlaywrightBrowser = (typeof PLAYWRIGHT_BROWSERS)[number]

/** Eviction threshold for automatically named outputs in the shared private directory. */
export const PLAYWRIGHT_OUTPUT_MAX_BYTES = 256 * 1024 * 1024

const PLAYWRIGHT_COMMANDS = ['playwright-mcp', 'playwright-mcp.cmd'] as const

export interface PlaywrightPresetFacts {
  command: (typeof PLAYWRIGHT_COMMANDS)[number]
  defaultBrowser: PlaywrightBrowser
  outputDirectory: string
}

export type PlaywrightPresetAvailability =
  | { kind: 'available'; facts: PlaywrightPresetFacts }
  /** The selected target is remote or account-isolated, so the Gateway's launchers do not exist there. */
  | { kind: 'unsupportedTarget' }
  /** A local same-account target whose Gateway did not provide a usable launcher. */
  | { kind: 'runtimeUnavailable' }

function isPlaywrightBrowser(value: unknown): value is PlaywrightBrowser {
  return (PLAYWRIGHT_BROWSERS as readonly unknown[]).includes(value)
}

function isOutputDirectory(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    value.length <= 4096 &&
    // Reject control characters; the value becomes a process argument.
    ![...value].some(character => character.charCodeAt(0) < 0x20 || character.charCodeAt(0) === 0x7f) &&
    (value.startsWith('/') || /^[A-Za-z]:\\/.test(value))
  )
}

/**
 * Decide whether the browser automation preset can be written for `target`.
 *
 * Availability follows the Gateway's inventory facts rather than the client's
 * own platform: the launcher lives on the Gateway host, which may differ from
 * the machine running this page.
 */
export function playwrightPresetAvailability(
  target: GatewayServer | null | undefined
): PlaywrightPresetAvailability {
  if (!target || target.transport !== 'local' || target.security) return { kind: 'unsupportedTarget' }
  const facts = target.localMcpPresets?.version === 1 ? target.localMcpPresets.playwright : undefined
  if (
    !facts ||
    !(PLAYWRIGHT_COMMANDS as readonly string[]).includes(facts.command) ||
    !isPlaywrightBrowser(facts.defaultBrowser) ||
    !isOutputDirectory(facts.outputDirectory)
  ) {
    return { kind: 'runtimeUnavailable' }
  }
  return {
    kind: 'available',
    facts: {
      command: facts.command as PlaywrightPresetFacts['command'],
      defaultBrowser: facts.defaultBrowser,
      outputDirectory: facts.outputDirectory,
    },
  }
}

/**
 * The exact `mcp_servers` entry the preset writes. `--isolated` keeps the
 * browser profile in memory, so neither the personal browser profile nor a
 * persistent automation profile is used. No extra capabilities are enabled.
 */
export function playwrightPresetConfig(facts: PlaywrightPresetFacts, browser: PlaywrightBrowser) {
  return {
    name: PLAYWRIGHT_PRESET_NAME,
    transport: 'stdio',
    command: facts.command,
    args: [
      '--browser',
      browser,
      '--isolated',
      '--output-dir',
      facts.outputDirectory,
      '--output-max-size',
      String(PLAYWRIGHT_OUTPUT_MAX_BYTES),
    ],
  }
}
