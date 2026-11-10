import { readFile } from 'node:fs/promises';
import { parseArgs } from 'node:util';
import { ChannelStore } from './store.mjs';
import { importChannels } from './migration.mjs';

const { values, positionals } = parseArgs({ allowPositionals: true,
  options: { root: { type: 'string' }, file: { type: 'string' } } });
if (positionals.length !== 1 || positionals[0] !== 'import' || !values.root || !values.file) {
  throw new Error('Usage: node src/channels/cli.mjs import --root <channel-directory> --file <private-bundle.json>');
}
const source = await readFile(values.file);
if (source.length > 8 * 1024 * 1024) throw new Error('CHANNEL_IMPORT_TOO_LARGE');
const store = new ChannelStore(values.root);
try { console.log(JSON.stringify({ imported: importChannels(store, JSON.parse(source)) })); }
finally { source.fill(0); store.close(); }
