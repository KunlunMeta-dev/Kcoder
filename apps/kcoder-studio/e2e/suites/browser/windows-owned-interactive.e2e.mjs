import { resolve } from 'node:path';
import { runE2E, repoRoot } from '../../harness/run-context.mjs';
import { startWindowsRemoteStudio } from '../../harness/windows-remote-studio.mjs';
import { resolveWindowsInteractiveOptions } from '../../harness/windows-interactive-options.mjs';
const { taskHost, testId, args } = resolveWindowsInteractiveOptions(process.env);
await runE2E(import.meta.url, {
 testId,
 tier:'manual-live',modelPolicy:'real Windows Electron and input; deterministic provider verifies protocol, configuration and focus, not model quality',
}, async context => {
 const host=await startWindowsRemoteStudio(context,{
  target:process.env.KCODER_E2E_WINDOWS_SSH_TARGET,
  installation:process.env.KCODER_E2E_WINDOWS_STUDIO_DIRECTORY,
  node:process.env.KCODER_E2E_WINDOWS_NODE,
  windowsBinary:process.env.KCODER_E2E_WINDOWS_CLI || resolve(repoRoot,'target/x86_64-pc-windows-gnu/release/kcoder.exe'),
  localOnly:true,
  candidateBundle:taskHost ? process.env.KCODER_E2E_WINDOWS_TASK_HOST_BUNDLE : undefined,
 });
 return host.runInteractive(args);
});
