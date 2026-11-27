/** A null generation carries existing v1/v2 intents until the first explicit toggle. */
export function migrateSettingsV2(document) {
  return { ...document, meta: { ...document.meta, config_version: 3 },
    channels: { ...document.channels, mirror_generation: document.channels?.mirror_generation ?? null } };
}
