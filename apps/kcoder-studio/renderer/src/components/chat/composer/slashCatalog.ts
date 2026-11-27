import catalog from './kcoderSlashCatalog.json'

export const kcoderSlashCatalog = catalog
export const kcoderBuiltinSlashNames = new Set(
  catalog.flatMap(command => [command.name, ...command.aliases])
)

// KWorker exposes its own actions through the workbench. Keep terminal-only
// administration and KCoder execution modes outside its composer.
export const kworkerSlashNames = new Set([
  '/help', '/?', '/model', '/mention', '/compact', '/context', '/ctx',
  '/plan', '/unplan', '/planstatus', '/new', '/clear', '/rename',
  '/copy', '/history', '/queue', '/sessions', '/resume', '/status', '/usage',
  '/skills', '/skill', '/apps', '/settings', '/theme', '/tools',
  '/wiki', '/knowledge', '/workflow', '/workflows', '/memories',
  '/tasks', '/agents', '/subagents', '/ps', '/todos', '/keys', '/keymap',
])
