// Private single-request process protocol. No caller-selected commands or paths.
import { generateOffice, inspectDependencies, OfficeError } from './index.mjs';
import { LIMITS } from './spec.mjs';
// Only framing gets this allowance; validateSpec still caps the full canonical
// specification at exactly 1 MiB and rejects unknown request/spec fields.
const MAX_INPUT = LIMITS.inputBytes + 16 * 1024;
let total = 0;
const chunks = [];
const write = value => new Promise((resolve, reject) => process.stdout.write(JSON.stringify(value), error => error ? reject(error) : resolve()));
try {
  for await (const chunk of process.stdin) {
    total += chunk.length;
    if (total > MAX_INPUT) throw new OfficeError('OFFICE_INPUT_TOO_LARGE', 'office.inputTooLarge');
    chunks.push(chunk);
  }
  const request = JSON.parse(Buffer.concat(chunks).toString('utf8'));
  if (!request || Object.getPrototypeOf(request) !== Object.prototype
    || Object.keys(request).some(key => !['method', 'specification', 'timeoutMs'].includes(key))) {
    throw new OfficeError('OFFICE_INVALID_INPUT', 'office.invalidInput');
  }
  if (request.method === 'probe') {
    const result = await inspectDependencies();
    await write({ ok: true, result: { ...result, supportedFormats: result.status === 'available' ? ['docx','xlsx','pptx'] : [],
      capabilities: { create: result.status === 'available', builtInTemplates: true, importTemplate: false, editExisting: false,
        pptxCharts: true, pptxPngImages: true,
        formulaWrite: result.status === 'available', formulaCache: false, recalculate: false,
        pdfConversion: false, readerVerification: false, arbitraryCode: false } } });
  } else if (request.method === 'generate') {
    const result = await generateOffice(request.specification, { timeoutMs: request.timeoutMs });
    const { bytes, ...metadata } = result;
    await write({ ok: true, result: { ...metadata, bytesBase64: Buffer.from(bytes).toString('base64') } });
  } else {
    throw new OfficeError('OFFICE_METHOD_UNSUPPORTED', 'office.methodUnsupported');
  }
} catch (error) {
  await write({ ok: false, error: { code: error instanceof OfficeError ? error.code : 'OFFICE_GENERATION_FAILED',
    messageKey: error instanceof OfficeError ? error.messageKey : 'office.generationFailed' } });
  process.exitCode = 1;
}
