import { constants } from 'node:fs';
import { createHash } from 'node:crypto';
import { chmod, copyFile, lstat, mkdir, mkdtemp, open, readFile, rename, rm } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';

const marker = await readFile(new URL('../../crates/kcoder_cli/release-metadata-marker.txt', import.meta.url));
const slotBytes = 4096;
const maximumBytes = 1024 * 1024 * 1024;

function slot(bytes) {
  const offset = bytes.indexOf(marker);
  if (offset < 0 || bytes.indexOf(marker, offset + 1) !== -1 || offset + slotBytes > bytes.length) {
    throw new Error('CLI has no unique release metadata slot; rebuild the native CLI once');
  }
  return offset;
}

export function decodeCliReleaseMetadata(bytes) {
  const offset = slot(bytes) + marker.length;
  const length = bytes.readUInt32LE(offset);
  if (length === 0) return null;
  if (length > slotBytes - marker.length - 4) throw new Error('Invalid CLI release metadata size');
  const metadata = JSON.parse(bytes.subarray(offset + 4, offset + 4 + length).toString('utf8'));
  validate(metadata);
  return metadata;
}

function validate(metadata) {
  if (metadata?.schemaVersion !== 1) throw new Error('Invalid CLI release metadata schema');
  for (const field of ['release', 'native']) {
    const value = metadata[field];
    if (!/^[0-9]+\.[0-9]+\.[0-9]+(?:[-+][A-Za-z0-9.+-]+)?$/.test(value?.version ?? '') ||
        typeof value?.dirty !== 'boolean' || !Number.isSafeInteger(value?.timeUnix) || value.timeUnix < 0 ||
        !(/^[a-f0-9]{40}$/.test(value?.commit ?? '') || (value?.commit === 'unknown' && value.dirty))) {
      throw new Error(`Invalid CLI ${field} provenance`);
    }
  }
  if (!/^[a-f0-9]{64}$/.test(metadata.native.artifactSha256 ?? '')) throw new Error('Invalid CLI native artifact digest');
}

export async function readCliReleaseMetadata(executable) {
  const info = await lstat(executable);
  if (!info.isFile() || info.isSymbolicLink() || info.size > maximumBytes) throw new Error('Invalid CLI executable');
  return decodeCliReleaseMetadata(await readFile(executable));
}

/** Mutate only the reserved data on an owned single-link copy, before signing. */
export async function stampCliReleaseMetadata(executable, metadata) {
  validate(metadata);
  const encoded = Buffer.from(JSON.stringify(metadata));
  if (encoded.length > slotBytes - marker.length - 4) throw new Error('CLI release metadata exceeds the reserved slot');
  const file = await open(executable, constants.O_RDWR | (constants.O_NOFOLLOW ?? 0));
  try {
    const before = await file.stat({ bigint: true });
    if (!before.isFile() || before.nlink !== 1n || before.size > BigInt(maximumBytes)) throw new Error('CLI metadata staging requires an owned single-link file');
    const bytes = await file.readFile();
    if (createHash('sha256').update(bytes).digest('hex') !== metadata.native.artifactSha256) {
      throw new Error('CLI staging bytes do not match their original native build');
    }
    const offset = slot(bytes) + marker.length;
    const data = Buffer.alloc(slotBytes - marker.length);
    data.writeUInt32LE(encoded.length); encoded.copy(data, 4);
    let written = 0;
    while (written < data.length) {
      const result = await file.write(data, written, data.length - written, offset + written);
      if (!result.bytesWritten) throw new Error('CLI metadata write made no progress');
      written += result.bytesWritten;
    }
    await file.sync();
  } finally { await file.close(); }
}

/** Keep Cargo outputs pristine; publish a complete owned staging copy atomically. */
export async function stageCliReleaseMetadata(source, destination, metadata) {
  await mkdir(dirname(destination), { recursive: true });
  const temporary = await mkdtemp(resolve(dirname(destination), '.cli-release-'));
  try {
    const staged = resolve(temporary, 'kcoder');
    await copyFile(source, staged);
    await stampCliReleaseMetadata(staged, metadata);
    await chmod(staged, 0o755);
    await rename(staged, destination);
  } finally { await rm(temporary, { recursive: true, force: true }); }
  return metadata;
}
