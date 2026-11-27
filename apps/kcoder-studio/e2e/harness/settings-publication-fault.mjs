// Faults only the declared owned fixture file, after its first rename.
import fs from 'node:fs/promises';
import { dirname, resolve, sep } from 'node:path';
import { syncBuiltinESMExports } from 'node:module';
if (process.env.KCODER_E2E_SETTINGS_PUBLICATION_FAULT === '1') {
  const root = resolve(process.env.KCODER_E2E_SETTINGS_PUBLICATION_ROOT || '');
  const path = resolve(process.env.KCODER_E2E_SETTINGS_PUBLICATION_PATH || '');
  if (!path.startsWith(root + sep)) throw Error('invalid owned publication fixture path');
  const rename = fs.rename, open = fs.open;
  let armed = false, remaining = 1;
  fs.rename = async (source, target) => {
    const result = await rename(source, target);
    if (String(target) === path && remaining) armed = true;
    return result;
  };
  fs.open = async (...args) => {
    const file = await open(...args), sync = file.sync.bind(file);
    if (String(args[0]) === dirname(path)) file.sync = async () => {
      if (armed && remaining) {
        armed = false; remaining--;
        if (process.env.KCODER_E2E_SETTINGS_PUBLICATION_MODE === 'changed') {
          await fs.writeFile(path, process.env.KCODER_E2E_SETTINGS_PUBLICATION_PEER, { mode: 0o600 });
        }
        throw Object.assign(Error('OWNED_DIRECTORY_SYNC_RECEIPT_LOST'), { code: 'EIO' });
      }
      return sync();
    };
    return file;
  };
  syncBuiltinESMExports();
}
