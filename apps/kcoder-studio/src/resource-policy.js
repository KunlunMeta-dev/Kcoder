import { constants } from 'node:fs';
import { lstat, open } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse } from 'jsonc-parser';

function object(value, keys) {
  if (!value || typeof value !== 'object' || Array.isArray(value) ||
      Object.keys(value).some(key => !keys.includes(key))) throw new Error('invalid resource policy fields');
  return value;
}

function integer(value, fallback, minimum, maximum) {
  if (value === undefined) return fallback;
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum)
    throw new Error('resource policy value is out of range');
  return value;
}

export function parseResourcePolicy(text) {
  const errors = [];
  const value = object(parse(text, errors, { allowTrailingComma: true }), ['$schema', 'meta', 'resources']);
  if (errors.length) throw new Error('invalid resource policy JSONC');
  if (value.$schema !== undefined && typeof value.$schema !== 'string') throw new Error('invalid resource policy schema reference');
  const meta = object(value.meta === undefined ? {} : value.meta, ['config_version']);
  if (meta.config_version !== undefined && meta.config_version !== 1) throw new Error('unsupported resource policy version');
  const resources = object(value.resources === undefined ? {} : value.resources, ['idle_budget']);
  const budget = object(resources.idle_budget === undefined ? {} : resources.idle_budget, ['max_processes', 'max_resident_bytes', 'sweep_interval_ms', 'sample_max_age_ms', 'sample_limit']);
  const maxProcesses = budget.max_processes == null ? null : integer(budget.max_processes, null, 0, 10_000);
  const maxResidentBytes = budget.max_resident_bytes == null ? null : integer(budget.max_resident_bytes, null, 0, Number.MAX_SAFE_INTEGER);
  return Object.freeze({
    maxProcesses, maxResidentBytes,
    enabled: maxProcesses !== null || maxResidentBytes !== null,
    sweepIntervalMs: integer(budget.sweep_interval_ms, 5_000, 1_000, 300_000),
    maxSampleAgeMs: integer(budget.sample_max_age_ms, 30_000, 1_000, 300_000),
    sampleLimit: integer(budget.sample_limit, 16, 1, 32),
  });
}

function unchangedFile(before, after) {
  return after.isFile() && before.dev === after.dev && before.ino === after.ino &&
    before.size === after.size && before.mtimeNs === after.mtimeNs &&
    before.ctimeNs === after.ctimeNs;
}

async function checkedPolicyPath(path) {
  const absolute = resolve(path instanceof URL ? fileURLToPath(path) : path);
  const info = await lstat(absolute, { bigint: true });
  if (info.isSymbolicLink() || !info.isFile()) throw new Error('resource policy must be a regular file without links');
  if (info.size > 65_536n) throw new Error('resource policy exceeds 64 KiB');
  for (let parent = dirname(absolute); ; parent = dirname(parent)) {
    const directory = await lstat(parent);
    if (directory.isSymbolicLink() || !directory.isDirectory()) throw new Error('resource policy parent must be a directory without links');
    if (dirname(parent) === parent) break;
  }
  return info;
}

export async function loadResourcePolicy(path, { required = false, noFollow = constants.O_NOFOLLOW } = {}) {
  const nativeNoFollow = Boolean(noFollow && noFollow === constants.O_NOFOLLOW);
  let before;
  if (!nativeNoFollow) {
    try { before = await checkedPolicyPath(path); }
    catch (error) {
      if (!required && error.code === 'ENOENT') return parseResourcePolicy('{}');
      throw error;
    }
  }
  let file;
  try {
    file = await open(path, constants.O_RDONLY | (nativeNoFollow ? noFollow : 0) | (constants.O_NONBLOCK ?? 0));
  } catch (error) {
    if (!required && error.code === 'ENOENT') return parseResourcePolicy('{}');
    throw new Error('cannot open resource policy file');
  }
  try {
    const opened = await file.stat({ bigint: true });
    if (!opened.isFile()) throw new Error('resource policy must be a regular file');
    if (before && !unchangedFile(before, opened)) throw new Error('resource policy changed while opening');
    const bytes = Buffer.alloc(65_537);
    let offset = 0;
    while (offset < bytes.length) {
      const { bytesRead } = await file.read(bytes, offset, bytes.length - offset, null);
      if (!bytesRead) break;
      offset += bytesRead;
    }
    if (offset > 65_536) throw new Error('resource policy exceeds 64 KiB');
    if (before && (!unchangedFile(before, await file.stat({ bigint: true })) ||
        !unchangedFile(before, await checkedPolicyPath(path)))) throw new Error('resource policy changed while reading');
    return parseResourcePolicy(new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(0, offset)));
  } finally { await file.close(); }
}
