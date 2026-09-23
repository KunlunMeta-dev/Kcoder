#!/usr/bin/env node
// Verification-only adapter for the pre-rename Linux WebView host. The host
// binary is an explicit copy under this worktree, never a personal app instance.
// execve preserves RunContext's exact process-group ownership and cleanup.
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { validateAiVerifyGatewayOrigin } from '../../renderer/scripts/ai-verify-environment.mjs';
const environment = { ...process.env };
for (const suffix of ['GATEWAY_ORIGIN', 'CONTROL_URL']) {
  const value = environment[`KCODER_STUDIO_AI_VERIFY_${suffix}`];
  validateAiVerifyGatewayOrigin(value);
  environment[`WEWORK_AI_VERIFY_${suffix}`] = value;
}
if (!environment.KCODER_STUDIO_AI_VERIFY_CONTROL_TOKEN) throw new Error('Owned controller token is required');
environment.WEWORK_AI_VERIFY_CONTROL_TOKEN = environment.KCODER_STUDIO_AI_VERIFY_CONTROL_TOKEN;
environment.WEWORK_APP_CONFIG_DIR = environment.KCODER_STUDIO_APP_CONFIG_DIR;
const binary = resolve(dirname(fileURLToPath(import.meta.url)), '../../renderer/target/native/app');
process.execve(binary, [binary], environment);
