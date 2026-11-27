export function resolveWindowsInteractiveOptions(env) {
  const enabled = name => env[`KCODER_E2E_WINDOWS_${name}`] === '1';
  const taskHost = enabled('TASK_HOST');
  const nativeInput = enabled('NATIVE_INPUT');
  const variants = [
    ['STREAMING', 'streaming', '--task-streaming'],
    ['TOOL_SELECTIONS', 'tool-selection', '--tool-selections'],
    ['KWORKER', 'kworker', '--kworker'],
  ].filter(([name]) => enabled(name));
  if (!taskHost && (variants.length || enabled('TASK_HOST_STDIO') || enabled('TASK_HOST_CANDIDATE'))) {
    throw new Error('Windows task-host options require KCODER_E2E_WINDOWS_TASK_HOST=1');
  }
  if (taskHost && nativeInput) throw new Error('Windows task-host and native-input modes are mutually exclusive');
  const ids = {
    streaming: 'windows-owned-task-streaming-latency',
    'tool-selection': 'windows-owned-kcoder-spec-tool-selection',
    kworker: 'windows-owned-task-kworker',
  };
  const testId = taskHost
    ? variants.length === 0 ? 'windows-owned-task-host-first-message'
      : variants.length === 1 ? ids[variants[0][1]] : `windows-owned-task-${variants.map(([, name]) => name).join('-')}`
    : nativeInput ? 'windows-owned-native-model-input' : 'windows-owned-model-settings-session';
  const args = taskHost
    ? ['--task-host', ...variants.map(([, , flag]) => flag), ...(enabled('TASK_HOST_STDIO') ? ['--stdio-only'] : enabled('TASK_HOST_CANDIDATE') ? [] : ['--installed-resources'])]
    : nativeInput ? ['--model-scope', '--native-input', '--installed-resources'] : ['--model-scope', '--installed-resources'];
  return { taskHost, testId, args };
}
