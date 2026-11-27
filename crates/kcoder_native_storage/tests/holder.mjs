import { createRequire } from 'node:module';

const [addonPath, root, name] = process.argv.slice(2);
const addon = createRequire(import.meta.url)(addonPath);
// This test owns this child and root. Deliberate process exit tests the kernel's
// release even when JavaScript did not explicitly close its native object.
const lease = addon.tryShared(root, name, false);
if (lease == null) throw new Error('owned child could not hold its storage lease');
process.send({ held: true });
process.on('message', (message) => {
  if (message === 'exit') process.exit(0);
});
process.on('disconnect', () => process.exit(0));
