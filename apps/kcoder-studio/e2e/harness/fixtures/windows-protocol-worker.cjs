// Synthetic headless protocol worker; never launches KCoder, a browser, a vault, or SSH.
const { closeSync } = require('node:fs');
const mode = process.env.KCODER_PROTOCOL_UI_MODE || process.argv[2];
if (mode === 'output') process.stdout.end(process.argv[3] || '');
else if (mode === 'exit') process.exit(23);
else if (mode === 'closed-stdin') {
  closeSync(0); setInterval(() => {}, 1000); process.stdout.write('OWNED_STDIN_CLOSED\n');
} else if (mode === 'ui-zero') {
  process.stdout.write('OWNED_PROTOCOL_WORKER_READY\n'); setTimeout(() => process.exit(0), 150);
} else if (mode === 'ui-hold' || mode === 'hold') {
  process.stdout.write('OWNED_PROTOCOL_WORKER_READY\n'); setInterval(() => {}, 1000);
} else throw new Error('Unsupported synthetic Windows protocol mode');
