// A real relaunched process: query the original operation only, with no model or business startup.
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import assert from 'node:assert/strict';
import { join } from 'node:path';

const [cli, home, operationId, proof, cacheRoot] = process.argv.slice(2);
assert.equal(process.env.KCODER_STORAGE_DESKTOP_RELAUNCH_V1, undefined);
assert.equal(process.env.KCODER_STORAGE_CONTEXT_V1, undefined);
assert.equal(process.env.ELECTRON_RUN_AS_NODE, undefined);
const receipt = JSON.parse(execFileSync(cli, ['--internal-storage-operation-v1', 'resume', operationId],
  { timeout: 10000, encoding: 'utf8', maxBuffer: 1024 * 1024 }));
assert.equal(receipt.plan.operationId, operationId);
assert.equal(receipt.disposition, 'complete');
assert.equal(receipt.phase, 'verified');
const location = JSON.parse(readFileSync(join(home, '.config', 'kcoder-storage.json'), 'utf8'));
assert.equal(location.cacheRoot, cacheRoot);
assert.equal(location.operationId, operationId);
writeFileSync(proof, JSON.stringify({ operationId, phase: receipt.phase, cacheRoot }), { flag: 'wx' });
