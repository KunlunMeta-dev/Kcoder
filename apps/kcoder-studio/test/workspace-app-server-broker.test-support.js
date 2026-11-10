import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { WorkspaceAppServerBroker } from '../src/workspace-app-server-broker.js';

export function fakeChild() {
  const child = new EventEmitter();
  child.stdin = new PassThrough();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  return child;
}

export function validInitializeParams() {
  return { protocolVersion: '2026-07-27', clientInfo: { name: 'broker-test', version: '1' } };
}

export function fakeClient(channel = 'runtime') {
  return {
    channel,
    messages: [],
    send(message) { this.messages.push(message); return true; },
    pause() {},
    resume() {},
    close() {},
  };
}

export function brokerFixture(options = {}) {
  const child = fakeChild();
  const broker = new WorkspaceAppServerBroker({
    child,
    adapter: {
      rawPassthrough: true,
      toUpstream: message => ({ upstream: [message], client: [] }),
      fromUpstream: message => ({ upstream: [], client: [message] }),
    },
    maxMessageBytes: 1024 * 1024,
    serverId: 'local',
    targetTransport: 'local',
    ...options,
  });
  const upstream = [];
  let buffered = '';
  child.stdin.on('data', chunk => {
    buffered += chunk.toString('utf8');
    for (;;) {
      const newline = buffered.indexOf('\n');
      if (newline < 0) break;
      upstream.push(JSON.parse(buffered.slice(0, newline)));
      buffered = buffered.slice(newline + 1);
    }
  });
  const respond = message => child.stdout.write(`${JSON.stringify(message)}\n`);
  return { broker, child, upstream, respond };
}
