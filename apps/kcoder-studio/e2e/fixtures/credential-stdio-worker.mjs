import { createInterface } from 'node:readline';

// A model-independent JSONL worker. Values arrive only through an owned private environment.
const secret = process.env.KCODER_CREDENTIAL_FIXTURE_VALUE;
const mode = process.env.KCODER_CREDENTIAL_FIXTURE_MODE ?? 'normal';
const reader = createInterface({ input: process.stdin, crlfDelay: Infinity });
const capabilities = { experimental: Object.fromEntries([
  'migrationCredentialsV1', 'migrationMcpCredentialsV1', 'migrationBatchMcpCredentialsV1',
  'migrationSourceTransferPrivateCredentialsV1', 'migrationSourceTransferPrivateCredentialBundlesV1',
  'migrationSourceTransferPrivateCredentialPreparationsV1',
].map(name => [name, true])) };
let first = true;
reader.on('close', () => { if (mode === 'hold-after-eof') setInterval(() => {}, 1000); });
reader.on('line', line => {
  try {
    const frame = JSON.parse(line);
    const reply = () => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: frame.id,
      result: frame.method === 'initialize' ? { capabilities } : { publicReceipt: true } }) + '\n');
    if (mode === 'stall') return;
    if (first && mode === 'exit-failure') { first = false; process.exitCode = 7; reader.close(); process.stdin.destroy(); return; }
    if (first && mode === 'stdout-secret') {
      first = false;
      process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: frame.id, result: { value: secret } }) + '\n');
      return;
    }
    if (first && mode === 'stdout-secret-escaped') {
      first = false;
      const encoded = [...secret].map(value => `\\u${value.charCodeAt(0).toString(16).padStart(4, '0')}`).join('');
      process.stdout.write(`{"jsonrpc":"2.0","id":${JSON.stringify(frame.id)},"result":{"value":"${encoded}"}}\n`);
      return;
    }
    if (first && mode === 'stderr-secret') {
      first = false;
      process.stderr.write(secret.slice(0, 32));
      setTimeout(() => process.stderr.write(secret.slice(32)), 10);
      return;
    }
    if (mode.startsWith('stdout-secret') || mode === 'stderr-secret') return;
    first = false; reply();
  } catch {
    process.exitCode = 3; reader.close(); process.stdin.destroy();
  }
});
