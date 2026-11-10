import { resolve } from 'node:path';
import { runE2E, repoRoot } from '../../harness/run-context.mjs';
import { startWindowsRemoteStudio } from '../../harness/windows-remote-studio.mjs';
const nativeInput = process.env.KCODER_E2E_WINDOWS_NATIVE_INPUT === '1';
const taskHost = process.env.KCODER_E2E_WINDOWS_TASK_HOST === '1';
const toolSelections = process.env.KCODER_E2E_WINDOWS_TOOL_SELECTIONS === '1';
const streaming = process.env.KCODER_E2E_WINDOWS_STREAMING === '1';
const kworker = process.env.KCODER_E2E_WINDOWS_KWORKER === '1';
await runE2E(import.meta.url, {
 testId: streaming ? 'windows-owned-task-streaming-latency' : toolSelections ? 'windows-owned-kcoder-spec-tool-selection' : taskHost ? 'windows-owned-task-host-first-message' : nativeInput ? 'windows-owned-native-model-input' : 'windows-owned-model-settings-session',
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
 return host.runInteractive(taskHost ? ['--task-host', ...(toolSelections ? ['--tool-selections'] : []), ...(streaming ? ['--task-streaming'] : []), ...(kworker ? ['--kworker'] : []), ...(process.env.KCODER_E2E_WINDOWS_TASK_HOST_STDIO === '1' ? ['--stdio-only'] : process.env.KCODER_E2E_WINDOWS_TASK_HOST_CANDIDATE === '1' ? [] : ['--installed-resources'])] : nativeInput ? ['--model-scope','--native-input','--installed-resources'] : ['--model-scope','--installed-resources']);
});
