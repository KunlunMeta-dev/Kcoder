import { resolve } from 'node:path';
import { runE2E, repoRoot } from '../../harness/run-context.mjs';
import { startWindowsRemoteStudio } from '../../harness/windows-remote-studio.mjs';
const nativeInput = process.env.KCODER_E2E_WINDOWS_NATIVE_INPUT === '1';
await runE2E(import.meta.url, {
 testId: nativeInput ? 'windows-owned-native-model-input' : 'windows-owned-model-settings-session',
 tier:'manual-live',modelPolicy:'real Windows Electron and input; deterministic provider verifies protocol, configuration and focus, not model quality',
}, async context => {
 const host=await startWindowsRemoteStudio(context,{
  target:process.env.KCODER_E2E_WINDOWS_SSH_TARGET,
  installation:process.env.KCODER_E2E_WINDOWS_STUDIO_DIRECTORY,
  node:process.env.KCODER_E2E_WINDOWS_NODE,
  windowsBinary:process.env.KCODER_E2E_WINDOWS_CLI || resolve(repoRoot,'target/x86_64-pc-windows-gnu/release/kcoder.exe'),
  localOnly:true,
 });
 return host.runInteractive(nativeInput ? ['--model-scope','--native-input'] : ['--model-scope']);
});
