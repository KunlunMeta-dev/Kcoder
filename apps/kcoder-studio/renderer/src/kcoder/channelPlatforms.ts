import definitions from '../../../../kcoder-channel-host/src/channel-platforms.json'

export type ChannelPlatform = keyof typeof definitions
interface ChannelPlatformDefinition {
  identityField: string
  credentialField: string
  configurationFields: readonly string[]
  configurationDefaults?: Record<string, unknown>
  authentication: string
  runtimeCapabilities: { text: boolean; attachments: boolean; cards: boolean; streaming: boolean }
  featureFields: Record<string, {
    type: string; default: string | number | boolean; options?: readonly string[]
    minimum?: number; maximum?: number; maxLength?: number
  }>
}

/** Public metadata only. No SDK code or credentials enter the browser bundle. */
export const channelPlatforms: Readonly<Record<ChannelPlatform, ChannelPlatformDefinition>> = definitions
