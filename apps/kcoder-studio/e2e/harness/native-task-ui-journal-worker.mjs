// Only finite hash diagnostics leave this owned short-lived journal reader.
import { execFileSync } from 'node:child_process';
import { parseTaskUiDiagnostics } from './native-task-ui-diagnostics.mjs';
const unit = process.argv[2];
if (process.platform !== 'linux' || !new RegExp(`^kcoder-native-user-${process.getuid()}-[a-f0-9]{64}\\.service$`).test(unit || ''))
  throw new Error('OWNED_TASK_UI_DIAGNOSTIC_UNIT_REQUIRED');
try {
  const raw = execFileSync('/usr/bin/journalctl', ['--user', '--no-pager', '-u', unit, '-n', '200', '-o', 'cat'],
    { encoding: 'utf8', timeout: 10_000, maxBuffer: 256 * 1024, stdio: ['ignore', 'pipe', 'pipe'] });
  process.stdout.write(JSON.stringify(parseTaskUiDiagnostics(raw)) + '\n');
} catch { throw new Error('OWNED_TASK_UI_DIAGNOSTIC_READ_UNAVAILABLE'); }
