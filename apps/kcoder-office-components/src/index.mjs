import { Worker } from 'node:worker_threads';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { OfficeError } from './errors.mjs';
import { validateSpec, LIMITS } from './spec.mjs';
import { generatorIdentity } from './identity.mjs';
export { inspectOffice } from './archive.mjs';
export { OfficeError } from './errors.mjs';
export { LIMITS } from './spec.mjs';

const require = createRequire(import.meta.url);
const MEDIA = Object.freeze({
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation'
});
const PINNED = Object.freeze({ docx: '9.5.1', exceljs: '4.4.0', pptxgenjs: '4.0.1', fflate: '0.8.3', saxes: '6.0.0' });

async function installedVersion(name) {
  let directory = dirname(require.resolve(name));
  for (let attempt = 0; attempt < 6; attempt += 1) {
    try {
      const value = JSON.parse(await readFile(join(directory, 'package.json'), 'utf8'));
      if (value.name === name) return value.version;
    } catch {}
    const parent = dirname(directory);
    if (parent === directory) break;
    directory = parent;
  }
  return null;
}

export async function inspectDependencies() {
  const components = {};
  for (const [name, expected] of Object.entries(PINNED)) {
    let version = null;
    try { version = await installedVersion(name); } catch {}
    components[name] = { version, expectedVersion: expected, status: version === expected ? 'available' : 'unavailable' };
  }
  const nodeMajor=Number(process.versions.node.split('.')[0]);
  return {
    runtime:{name:'node',version:process.versions.node,minimumMajor:22,status:nodeMajor>=22?'available':'unavailable',hostKind:process.versions.electron?'electron':'node',electronVersion:process.versions.electron??null,electronRunAsNode:Boolean(process.versions.electron)&&process.env.ELECTRON_RUN_AS_NODE==='1'},
    fonts:{requestedFamily:'Noto Sans SC',status:'requires_native_observation'},
    status: nodeMajor>=22 && Object.values(components).every(component => component.status === 'available') ? 'available' : 'unavailable',
    components, readerStatus: 'not_checked', generator: await generatorIdentity()
  };
}

export async function generateOffice(input, options = {}) {
  const spec = validateSpec(input);
  const timeoutMs = options.timeoutMs ?? LIMITS.waitMs;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 60_000) {
    throw new OfficeError('OFFICE_INVALID_INPUT', 'office.invalidWaitBudget');
  }
  if (options.signal?.aborted) throw new OfficeError('OFFICE_CANCELLED', 'office.cancelled', 'none');
  if ((await inspectDependencies()).status !== 'available') {
    throw new OfficeError('OFFICE_DEPENDENCY_UNAVAILABLE', 'office.dependencyUnavailable');
  }
  return new Promise((resolve, reject) => {
    const worker = new Worker(new URL('./worker.mjs', import.meta.url), {
      workerData: spec,
      resourceLimits: { maxOldGenerationSizeMb: 192, maxYoungGenerationSizeMb: 32, stackSizeMb: 4 },
      stdout: true, stderr: true
    });
    // Vendor logs are not a trusted or bounded diagnostic protocol.
    worker.stdout.resume();
    worker.stderr.resume();
    let settled = false;
    const finish = async (error, output) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      options.signal?.removeEventListener('abort', abort);
      try { await worker.terminate(); }
      catch { reject(new OfficeError('OFFICE_CLEANUP_UNCONFIRMED', 'office.cleanupUnconfirmed', 'reconcile_original')); return; }
      if (error) reject(error); else resolve(output);
    };
    const abort = () => void finish(new OfficeError('OFFICE_CANCELLED', 'office.cancelled', 'none'));
    const timer = setTimeout(() => void finish(new OfficeError('OFFICE_TIMEOUT', 'office.timeout', 'none')), timeoutMs);
    options.signal?.addEventListener('abort', abort, { once: true });
    if (options.signal?.aborted) { abort(); return; }
    worker.once('message', message => {
      if (!message?.ok) {
        void finish(new OfficeError(message?.code ?? 'OFFICE_GENERATION_FAILED', message?.messageKey ?? 'office.generationFailed'));
        return;
      }
      const bytes = message.bytes;
      if (!(bytes instanceof Uint8Array) || bytes.byteLength > LIMITS.outputBytes || message.inspection?.kind !== spec.kind
        || !message.generator || !/^[a-f0-9]{64}$/.test(message.generator.implementationSha256 ?? '') || !/^[a-f0-9]{64}$/.test(message.generator.dependencyLockSha256 ?? '')) {
        void finish(new OfficeError('OFFICE_GENERATION_FAILED', 'office.invalidWorkerResult'));
        return;
      }
      void finish(null, {
        kind: spec.kind, mediaType: MEDIA[spec.kind], bytes,
        size: bytes.byteLength, sha256: createHash('sha256').update(bytes).digest('hex'),
        sourceRefs: spec.sourceRefs ?? [],
        generator: message.generator,
        verification: { structuralStatus: message.inspection.structuralStatus, readerStatus: 'unverified',
          formulaCalculation: spec.kind === 'xlsx' ? 'not_performed' : 'not_applicable' }
      });
    });
    worker.once('error', () => void finish(new OfficeError('OFFICE_GENERATION_FAILED', 'office.workerFailed')));
    worker.once('exit', () => {
      if (!settled) void finish(new OfficeError('OFFICE_GENERATION_FAILED', 'office.workerExited'));
    });
  });
}
