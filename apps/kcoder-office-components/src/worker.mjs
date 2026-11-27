import { parentPort, workerData } from 'node:worker_threads';
import { generateBytes } from './generator.mjs';
import { inspectOffice } from './archive.mjs';
import { LIMITS } from './spec.mjs';
import { generatorIdentity } from './identity.mjs';

try {
  const generator = await generatorIdentity();
  const bytes = await generateBytes(workerData);
  if (bytes.byteLength > LIMITS.outputBytes) throw Object.assign(new Error(), { code: 'OFFICE_OUTPUT_TOO_LARGE', messageKey: 'office.outputTooLarge' });
  const inspection = inspectOffice(bytes, workerData.kind);
  if (JSON.stringify(await generatorIdentity()) !== JSON.stringify(generator)) throw Object.assign(new Error(), { code: 'OFFICE_COMPONENT_IDENTITY_CHANGED', messageKey: 'office.componentUnavailable' });
  parentPort.postMessage({ ok: true, bytes, inspection, generator }, [bytes.buffer]);
} catch (error) {
  parentPort.postMessage({ ok: false, code: error?.code?.startsWith('OFFICE_') ? error.code : 'OFFICE_GENERATION_FAILED',
    messageKey: error?.messageKey ?? 'office.generationFailed' });
}
