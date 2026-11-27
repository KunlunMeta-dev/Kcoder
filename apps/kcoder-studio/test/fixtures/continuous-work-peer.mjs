// Controlled JSONL peer for the Gateway integration test; this is not an app-server.
import { appendFileSync, readFileSync } from 'node:fs';
import { createInterface } from 'node:readline';

const settings = JSON.parse(readFileSync('controlled-peer.json', 'utf8'));
const trace = process.env.KCODER_P1_TEST_TRACE;
const record = event => appendFileSync(trace, `${JSON.stringify({ ...event, pid: process.pid, target: settings.target })}\n`);
record({ event: 'spawn', nativeOffice: Boolean(process.env.KCODER_NATIVE_OFFICE_BINDING_V1),
  nativeConnectivity: Boolean(process.env.KCODER_NATIVE_CONNECTIVITY_BINDING_V1) });
process.on('exit', () => record({ event: 'exit' }));
process.on('SIGTERM', () => process.exit(0));
process.on('SIGINT', () => process.exit(0));
process.stdin.on('end', () => process.exit(0));
createInterface({ input: process.stdin }).on('line', line => {
  const request = JSON.parse(line);
  record({ event: 'request', method: request.method });
  let result;
  switch (request.method) {
    case 'initialize':
      result = { protocolVersion: '2026-07-27', serverInfo: { name: 'controlled-peer', version: '1' },
        capabilities: { experimental: { residentThreads: true, ...(settings.advertiseWork
          ? { continuousWorkV1: true, continuousWorkNoEphemeralV1: true } : {}) } } };
      break;
    case 'thread/start': result = { thread: { id: 'owned-thread' } }; break;
    case 'turn/start': result = { turn: { id: 'owned-turn', threadId: request.params.threadId } }; break;
    case 'work/list': result = { items: [{ workId: 'work-1', threadId: 'owned-thread', phase: 'running',
      revision: 1, requirementsRevision: 1, freshness: 'current' }] }; break;
    default:
      if (request.id !== undefined) process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id: request.id,
        error: { code: -32601, message: 'controlled peer: unsupported method' } })}\n`);
      return;
  }
  if (request.id !== undefined) process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id: request.id, result })}\n`);
});
