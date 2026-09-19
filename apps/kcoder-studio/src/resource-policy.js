import { constants } from 'node:fs';
import { lstat, open } from 'node:fs/promises';
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

export async function loadResourcePolicy(path, { required = false, noFollow = constants.O_NOFOLLOW } = {}) {
  if (!noFollow || noFollow !== constants.O_NOFOLLOW) {
    try { await lstat(path); }
    catch (error) {
      if (!required && error.code === 'ENOENT') return parseResourcePolicy('{}');
      throw new Error('cannot open resource policy file');
    }
    throw new Error('secure resource policy opening is unsupported on this platform');
  }
  let file;
  try {
    file = await open(path, constants.O_RDONLY | noFollow | (constants.O_NONBLOCK ?? 0));
  } catch (error) {
    if (!required && error.code === 'ENOENT') return parseResourcePolicy('{}');
    throw new Error('cannot open resource policy file');
  }
  try {
    if (!(await file.stat()).isFile()) throw new Error('resource policy must be a regular file');
    const bytes = Buffer.alloc(65_537);
    let offset = 0;
    while (offset < bytes.length) {
      const { bytesRead } = await file.read(bytes, offset, bytes.length - offset, null);
      if (!bytesRead) break;
      offset += bytesRead;
    }
    if (offset > 65_536) throw new Error('resource policy exceeds 64 KiB');
    return parseResourcePolicy(new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(0, offset)));
  } finally { await file.close(); }
}
