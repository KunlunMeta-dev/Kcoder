import { mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';
import { readBoundedFile, writePrivateFile } from '../../kcoder-channel-host/src/jsonc-file.mjs';

const serverBytes = values => Buffer.from(`${JSON.stringify(values, null, 2)}\n`);
const unconfirmed = () => Object.assign(new Error('CONFIG_FILE_PUBLISH_UNCONFIRMED'),
  { code: 'CONFIG_FILE_PUBLISH_UNCONFIRMED', externalOutcome: 'unknown' });

/** Serialize the complete read/modify/publish cycle, including in-memory state. */
export function createServerMutationQueue() {
  let tail = Promise.resolve();
  return operation => {
    const current = tail.then(operation);
    tail = current.catch(() => {});
    return current;
  };
}

export async function writeServerConfiguration(path, values) {
  if (!path) return;
  return publishServerBytes(path, serverBytes(values));
}

async function publishServerBytes(path, prepared) {
  if (!path) return;
  try {
    await mkdir(dirname(path), { recursive: true });
    await writePrivateFile(path, prepared);
  } catch (cause) {
    if (cause.code === 'CONFIG_FILE_PUBLISH_UNCONFIRMED') throw cause;
    throw Object.assign(new Error('SERVER_CONFIGURATION_SAVE_FAILED', { cause }), { code: 'SERVER_CONFIGURATION_SAVE_FAILED' });
  }
}

/** Original-attempt projection gate; it neither retries writes nor confirms durability. */
export function createServerConfigurationPublisher(path) {
  let blocked = false;
  const assertCurrent = () => { if (blocked) throw unconfirmed(); };
  return {
    assertCurrent,
    async publish(values) {
      assertCurrent();
      const prepared = path ? serverBytes(values) : null;
      try { await publishServerBytes(path, prepared); return { unconfirmed: null }; }
      catch (error) {
        if (error.code !== 'CONFIG_FILE_PUBLISH_UNCONFIRMED') throw error;
        let observed;
        try { observed = await readBoundedFile(path, prepared.length); } catch {}
        if (!observed?.equals(prepared)) {
          // The old runtime catalog cannot authorize another merge over this file.
          // Explicit process restart/reconciliation must load the current authority.
          blocked = true; throw error;
        }
        // Only this original caller may continue its already authorized postprocessing.
        return { unconfirmed: error };
      }
    },
  };
}

/** Only the exact publisher code or this mutation's own publication fence grants unknown. */
export function configurationPublicationFailure(error, published = false) {
  if (!published && error?.code !== 'CONFIG_FILE_PUBLISH_UNCONFIRMED') return null;
  return { error: 'CONFIG_FILE_PUBLISH_UNCONFIRMED', code: 'CONFIG_FILE_PUBLISH_UNCONFIRMED', externalOutcome: 'unknown' };
}
