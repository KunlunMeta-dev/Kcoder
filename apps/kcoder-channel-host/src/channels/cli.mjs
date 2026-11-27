import { parseArgs } from 'node:util';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { ChannelStore } from './store.mjs';
import { importChannels, validateChannelImport, CHANNEL_IMPORT_MAX_BYTES } from './migration.mjs';
import { readBoundedFile } from '../jsonc-file.mjs';

/** The raw buffer wipe is best effort; immutable parsed strings remain managed by V8. */
export async function runChannelImport(args = process.argv.slice(2)) {
  let parsed;
  try { parsed = parseArgs({ args, allowPositionals: true, options: { root: { type: 'string' }, file: { type: 'string' } } }); }
  catch { throw new Error('CHANNEL_IMPORT_ARGUMENTS_INVALID'); }
  const { values, positionals } = parsed;
  if (positionals.length !== 1 || positionals[0] !== 'import' || !values.root || !values.file) throw new Error('CHANNEL_IMPORT_ARGUMENTS_INVALID');
  let source, store, failed = false;
  try {
    try { source = await readBoundedFile(values.file, CHANNEL_IMPORT_MAX_BYTES); }
    catch (error) { throw new Error(error.code === 'CONFIG_FILE_TOO_LARGE' ? 'CHANNEL_IMPORT_TOO_LARGE' : 'CHANNEL_IMPORT_FILE_INVALID'); }
    let bundle;
    try { bundle = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(source)); }
    catch { throw new Error('CHANNEL_IMPORT_FILE_INVALID'); }
    validateChannelImport(bundle);
    store = new ChannelStore(values.root);
    return { root: store.directory, imported: importChannels(store, bundle), listenersStarted: false };
  } catch (error) { failed = true; throw error; }
  finally {
    source?.fill(0);
    try { store?.close(); } catch { if (!failed) throw new Error('CHANNEL_IMPORT_CLOSE_UNCONFIRMED'); }
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try { console.log(JSON.stringify(await runChannelImport())); }
  catch (error) {
    console.error(/^CHANNEL_[A-Z0-9_]+$/.test(error?.message ?? '') ? error.message : 'CHANNEL_IMPORT_FAILED');
    if (error?.message === 'CHANNEL_IMPORT_ARGUMENTS_INVALID') console.error('Usage: node apps/kcoder-channel-host/src/channels/cli.mjs import --root <channel-directory> --file <private-bundle.json>');
    process.exitCode = 1;
  }
}
