type NativeRecord = import('./generated/contracts').NativeStartupDiagnosticV1;
export interface NativeStartupDiagnostic extends Omit<NativeRecord, 'code'> {
  version: 1;
  code: NativeRecord['code'] | 'native_startup_failed' | 'launcher_unavailable' | 'launcher_access_denied';
  phase: NativeRecord['phase'];
  exitCode?: number;
  signal?: string;
  launch?: {
    transport: 'local' | 'ssh';
    commandSource: 'target_explicit' | 'gateway_default' | 'unknown';
    settingsSource: 'explicit_overlay' | 'target_default';
    command?: string;
    settingsFile?: string;
    profile?: string;
  };
}
export function nativeStartupDiagnostic(value: unknown): NativeStartupDiagnostic | null;
export function nativeStartupDiagnosticFromError(error: unknown): NativeStartupDiagnostic | null;
export function nativeStartupErrorMessage(code: string): string;
