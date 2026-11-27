/** Closed startup facts from an actual owned process; no stderr, credentials or argv. */
import { isNativeStartupDiagnosticV1 } from './generated/contractGuards.core.mjs';
const gatewayCodes = new Set(['native_startup_failed', 'launcher_unavailable', 'launcher_access_denied']);
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const boundedText = (value, maximum) => typeof value === 'string' && value.length > 0 &&
  utf8Bytes(value) <= maximum && !/[\u0000-\u001f\u007f-\u009f]/u.test(value);
function utf8Bytes(value) {
  let size = 0;
  for (const c of value) { const code = c.codePointAt(0); size += code <= 0x7f ? 1 : code <= 0x7ff ? 2 : code <= 0xffff ? 3 : 4; }
  return size;
}
export function nativeStartupDiagnosticFromError(error) {
  return object(error) && object(error.data) ? nativeStartupDiagnostic(error.data.startupDiagnostic) : null;
}
export function nativeStartupDiagnostic(value) {
  if (!object(value)) return null;
  const native = isNativeStartupDiagnosticV1({ version: value.version, code: value.code, phase: value.phase });
  if (!native && !(value.version === 1 && gatewayCodes.has(value.code) && ['launch', 'initialize'].includes(value.phase))) return null;
  const result = { version: 1, code: value.code, phase: value.phase };
  if (Number.isInteger(value.exitCode) && value.exitCode >= -2147483648 && value.exitCode <= 2147483647) result.exitCode = value.exitCode;
  if (typeof value.signal === 'string' && /^SIG[A-Z0-9]{1,16}$/.test(value.signal)) result.signal = value.signal;
  if (object(value.launch)) {
    const launch = value.launch;
    if (['local', 'ssh'].includes(launch.transport) &&
        ['target_explicit', 'gateway_default', 'unknown'].includes(launch.commandSource) &&
        ['explicit_overlay', 'target_default'].includes(launch.settingsSource)) {
      result.launch = { transport: launch.transport, commandSource: launch.commandSource, settingsSource: launch.settingsSource };
      for (const [name, maximum] of [['command', 2048], ['settingsFile', 2048], ['profile', 256]])
        if (boundedText(launch[name], maximum)) result.launch[name] = launch[name];
    }
  }
  return result;
}
export function nativeStartupErrorMessage(code) {
  return ({
    launcher_unavailable: 'The configured KCoder launcher is unavailable.',
    launcher_access_denied: 'The configured KCoder launcher cannot be opened by this account.',
    provider_unconfigured: 'Choose a Provider and model in Settings before starting a turn.',
    model_limits_missing: 'The selected model is missing required context or output limits.',
    settings_parse_failed: 'The selected settings file could not be parsed.',
    settings_schema_invalid: 'The selected settings contain unsupported or invalid values.',
    settings_overlay_unavailable: 'The selected settings file could not be opened.',
    config_private_access: 'KCoder cannot open its private configuration for this account.',
  })[code] ?? 'The configured KCoder process exited before initialization.';
}
