#!/usr/bin/env node
// Protocol-only owned argv observer; never loads KCoder settings or calls a model.
import { appendFile } from 'node:fs/promises';
import { createInterface } from 'node:readline';
import { join } from 'node:path';
await appendFile(join(import.meta.dirname, 'argv.jsonl'), JSON.stringify({ pid: process.pid, args: process.argv.slice(2), cwd: process.cwd() }) + '\n');
const lines = createInterface({ input: process.stdin });
for await (const line of lines) {
  const message = JSON.parse(line);
  if (message.id === undefined) continue;
  const result = message.method === 'initialize'
    ? { protocolVersion: '2026-07-27', serverInfo: { name: 'owned-profile-argv-fixture', version: '1' }, capabilities: {}, cwd: process.cwd() }
    : {};
  process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: message.id, result }) + '\n');
}
