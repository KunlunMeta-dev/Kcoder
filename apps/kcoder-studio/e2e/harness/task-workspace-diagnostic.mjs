import { isAbsolute, basename } from 'node:path';
import { writeFileSync } from 'node:fs';
import { WorkspaceAppServerBroker } from '../../src/workspace-app-server-broker.js';
import { lookupDiagnosticCodes } from './task-workspace-diagnostic-facts.mjs';

const file = process.env.KCODER_E2E_LOOKUP_DIAGNOSTIC_FILE;
if (!file || !isAbsolute(file) || basename(file) !== 'native-lookup-diagnostic.json')
  throw new Error('Owned lookup diagnostic path required');
const events = [], seen = new WeakSet();
const original = WorkspaceAppServerBroker.prototype.attach;
const persist = () => writeFileSync(file, JSON.stringify({ fixtureOnly: true, bodyOrCredentialsRecorded: false, events }, null, 2) + '\n', { mode: 0o600 });
persist();
WorkspaceAppServerBroker.prototype.attach = function (...args) {
  if (!seen.has(this)) {
    seen.add(this); const pid = this.child.pid;
    const observe = lookupDiagnosticCodes(code => {
      if (events.length >= 32) return;
      events.push({ pid, code }); persist();
    });
    this.child.stderr.on('data', observe);
  }
  return original.apply(this, args);
};
