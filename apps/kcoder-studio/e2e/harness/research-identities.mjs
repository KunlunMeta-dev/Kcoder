import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { stat, realpath } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

export const OCTOP_RESEARCH_COMMIT = 'dd9dce470844c25d59effb50615bb3c667ea25cd';
const execute = promisify(execFile);
const fingerprint = info => [info.dev, info.ino, info.size, info.mtimeNs].map(String).join(':');

export async function binaryResearchIdentity(path, expectedSha256) {
  const before = fingerprint(await stat(path, { bigint: true }));
  const hash = createHash('sha256');
  for await (const bytes of createReadStream(path)) hash.update(bytes);
  const sha256 = hash.digest('hex');
  if (before !== fingerprint(await stat(path, { bigint: true }))) throw Error('Research binary changed while hashing; no model request started');
  if (expectedSha256 && (!/^[a-f0-9]{64}$/i.test(expectedSha256) || sha256 !== expectedSha256.toLowerCase()))
    throw Error('Research CLI hash does not match the frozen evaluation input');
  return { sha256, fingerprint: before };
}

export async function assertResearchBinary(path, identity) {
  if (fingerprint(await stat(path, { bigint: true })) !== identity.fingerprint)
    throw Error('Frozen research binary changed; completed samples retained, later groups not dispatched');
}

export async function octopResearchIdentity(context, root) {
  const path = await realpath(root);
  const options = { env: context.isolatedEnvironment({ GIT_CONFIG_NOSYSTEM: '1' }), encoding: 'utf8', timeout: 10000, maxBuffer: 1024 * 1024 };
  let commit, dirty;
  try {
    commit = (await execute('git', ['-C', path, 'rev-parse', 'HEAD'], options)).stdout.trim();
    dirty = (await execute('git', ['-C', path, 'status', '--porcelain'], options)).stdout.trim().length > 0;
  } catch { throw Error('UNMET_PREREQUISITE: Octop repository identity unavailable'); }
  if (commit !== OCTOP_RESEARCH_COMMIT || dirty) throw Error('UNMET_PREREQUISITE: Octop baseline must retain the clean reviewed source commit');
  return { commit, dirty: false };
}
