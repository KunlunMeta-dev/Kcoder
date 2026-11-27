import { spawn } from 'node:child_process';
import { unlinkSync, writeFileSync, writeSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const scenario = process.argv[2];
const ownerModule = process.env.KCODER_OFFLINE_OWNER_CHILD_MODULE;
const { createOfflineOwnerProtocol, runOfflineOwnerChild } = await import(pathToFileURL(ownerModule).href);

if (scenario === 'invalid-json') {
  writeSync(1, Buffer.from('[]\n'));
  process.exit(0);
}
if (scenario === 'oversized-frame') {
  const frame = Buffer.alloc(1024 * 1024 + 1, 0x78);
  frame[frame.length - 1] = 0x0a;
  writeSync(1, frame);
  process.exit(0);
}

const wire = createOfflineOwnerProtocol();
let rootFact;
let fenceCount = 0;
const replaceSecondary = () => {
  const path = join(rootFact.root, 'kcoder-storage-instances.lock');
  unlinkSync(path);
  writeFileSync(path, '');
};
const protocol = Object.freeze({
  read() {
    const frame = wire.read();
    if (frame.type === 'initialize') rootFact = frame.roots[0];
    return frame;
  },
  write(frame) {
    if (scenario === 'ready-without-completed' && frame.type === 'ready') {
      wire.write(frame);
      process.exit(0);
    }
    if (scenario === 'malformed-frame' && frame.type === 'validateFences') {
      wire.write({ ...frame, unexpected: true });
      return;
    }
    if (scenario === 'forged-fences' && frame.type === 'validateFences' && fenceCount++ === 0) {
      wire.write({ ...frame, facts: [{ ...frame.facts[0], primaryIdentity: `${frame.facts[0].primaryIdentity}-forged` }] });
      return;
    }
    if (scenario === 'invalidate-parent-fence' && frame.type === 'validateFences' && fenceCount++ === 0) {
      replaceSecondary();
    }
    wire.write(frame);
  },
});

const native = Object.freeze({
  tryExclusive(root, name, create) {
    if (name !== 'kcoder-storage-instances.lock' || create !== false) throw new Error('unexpected fake Native request');
    return Object.freeze({ root });
  },
  verify(lease) {
    if (!lease) throw new Error('missing fake Native lease');
  },
  close() {},
});

try {
  await runOfflineOwnerChild({
    protocol,
    native,
    run: async (payload, { operationId, validateOffline }) => {
      const facts = { ...payload.facts };
      if (scenario === 'domain-facts-out-of-scope') facts.source = join(facts.source, 'outside');
      validateOffline(facts);
      if (scenario === 'hang-with-descendant') {
        writeFileSync(payload.started, 'started');
        const code = `setTimeout(() => require('node:fs').writeFileSync(${JSON.stringify(payload.ownedMarker)}, 'alive'), 1400)`;
        spawn(process.execPath, ['-e', code], { stdio: 'ignore' });
        await new Promise(resolve => setTimeout(resolve, 30000));
      }
      writeFileSync(payload.business, 'written by the offline owner');
      return { operationId, written: true };
    },
  });
  if (scenario === 'nonzero-after-completed') process.exitCode = 23;
} catch (error) {
  try { wire.write({ type: 'failed', code: error.code ?? 'STORAGE_OFFLINE_CHILD_FAILED' }); } catch {}
  process.exitCode = 1;
}
