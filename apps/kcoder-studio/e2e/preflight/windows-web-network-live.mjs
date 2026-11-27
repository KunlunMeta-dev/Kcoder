import assert from 'node:assert/strict';
import { runWindowsWebNetwork } from './windows-web-network.mjs';

assert.equal(process.env.KCODER_E2E_WINDOWS_NATIVE_LIBTEST, '1');
assert.equal(process.env.KCODER_E2E_WEB_EXTERNAL_NETWORK, '1');
const scope = process.env.KCODER_E2E_WEB_NATIVE_SCOPE || 'external-read';
assert.ok(['external-read','external-diagnostic','external-python','external-python-diagnostic','external-python-direct','external-python-hostname-diagnostic'].includes(scope), 'Unknown external native web scope');
await runWindowsWebNetwork({ scope, externalAuthorized: true, sourceUrl: import.meta.url });
