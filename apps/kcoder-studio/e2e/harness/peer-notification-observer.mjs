import { writeFileSync } from 'node:fs';
import { basename, isAbsolute } from 'node:path';
import { WorkspaceAppServerBroker } from '../../src/workspace-app-server-broker.js';
import { observeOwnedPeerBroker } from './peer-notification-facts.mjs';

// Only this owned Gateway's explicit --import installs the transparent observer.
const file = process.env.KCODER_E2E_PEER_NOTICE_DIAGNOSTICS_FILE;
if (!file || !isAbsolute(file) || basename(file) !== 'peer-notification-diagnostics.json')
  throw new Error('Owned peer notification diagnostic path required');
const events = [];
let dropped = 0, observerErrors = 0;
const persist = () => writeFileSync(file, JSON.stringify({ fixtureOnly: true, bodyOrCredentialsRecorded: false,
  dropped, observerErrors, events }, null, 2) + '\n', { mode: 0o600 });
persist();
observeOwnedPeerBroker(WorkspaceAppServerBroker, event => {
  if (events.length < 256) events.push(event); else dropped++;
  try { persist(); } catch {
    observerErrors++;
    process.stderr.write('OWNED_PEER_DIAGNOSTICS_UNCONFIRMED\n');
  }
});
