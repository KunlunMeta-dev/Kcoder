import { readFileSync, writeFileSync } from 'node:fs';

/** Preserve timestamps and watchers when generation produces identical bytes. */
export function writeGeneratedArtifact(path, content) {
  try {
    if (readFileSync(path, 'utf8') === content) return false;
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  writeFileSync(path, content);
  return true;
}
