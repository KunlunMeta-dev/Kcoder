import { connect } from 'node:tls';
import { isolatedGatewayUrl } from './gateway-origin.mjs';

const HANDSHAKE_TIMEOUT_MS = 30_000;
const RETRY_DELAY_MS = 30_000;
const MAX_CONCURRENT_HANDSHAKES = 2;

function verifyTls(port, servername, signal) {
  return new Promise((resolve, reject) => {
    const socket = connect({ host: '127.0.0.1', port, servername, signal, rejectUnauthorized: true });
    const timer = setTimeout(() => socket.destroy(new Error('Gateway TLS preparation timed out')), HANDSHAKE_TIMEOUT_MS);
    socket.once('error', reject);
    socket.once('secureConnect', () => {
      resolve();
      socket.destroy();
    });
    socket.once('close', () => {
      clearTimeout(timer);
      reject(new Error('Gateway TLS connection closed'));
    });
  });
}

export function createPublicIngress(origin, verify = verifyTls) {
  const jobs = new Map();
  let running = 0;
  let closed = false;

  function drain() {
    for (const job of jobs.values()) {
      if (closed || running >= MAX_CONCURRENT_HANDSHAKES) break;
      if (job.status !== 'queued') continue;
      job.status = 'preparing';
      const controller = new AbortController();
      job.controller = controller;
      running++;
      void Promise.resolve().then(() => {
        controller.signal.throwIfAborted();
        return verify(job.port, job.hostname, controller.signal);
      }).then(() => {
        job.status = 'ready';
      }, () => {
        job.status = 'failed';
        job.retryAt = Date.now() + RETRY_DELAY_MS;
      }).finally(() => {
        job.controller = undefined;
        running--;
        drain();
      });
    }
  }

  function prepare(id) {
    if (closed || !origin) return;
    const existing = jobs.get(id);
    if (existing && (existing.status !== 'failed' || existing.retryAt > Date.now())) return;
    const url = isolatedGatewayUrl(origin, id);
    jobs.set(id, { status: 'queued', hostname: url.hostname, port: Number(url.port || 443) });
    drain();
  }

  function remove(id) {
    jobs.get(id)?.controller?.abort();
    jobs.delete(id);
  }

  return {
    prepare,
    status(id, requestOrigin) {
      if (!origin || requestOrigin !== origin) return 'ready';
      prepare(id);
      return jobs.get(id)?.status ?? 'preparing';
    },
    remove,
    close() {
      closed = true;
      for (const id of jobs.keys()) remove(id);
    },
  };
}
