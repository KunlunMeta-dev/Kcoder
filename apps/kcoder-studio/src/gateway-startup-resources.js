// Consume each private input synchronously; overlap independent full verification.
import { captureGatewayNativeOfficeStartup } from './server-config.js';
import { captureGatewayNativeConnectivityStartup } from './integrations/connectivity/resource-host.mjs';

export async function captureGatewayStartupResources({
  observation, environment = process.env,
  office = captureGatewayNativeOfficeStartup,
  channel = captureGatewayNativeConnectivityStartup,
  warn = code => console.warn(code),
}) {
  const report = code => { try { warn(code); } catch { /* Diagnostics are optional. */ } };
  const capture = (phase, operation, code) => observation.run(phase,
    () => operation(environment)).catch(() => { report(code); return null; });
  // Calling both operations before awaiting either preserves consume-and-delete
  // before any later Gateway work or child spawn can see the private values.
  const channelResult = capture('channel_resources', channel, 'CHANNEL_NATIVE_UNAVAILABLE');
  const officeResult = capture('office_resources', office, 'OFFICE_NATIVE_UNAVAILABLE');
  const [officeBinding, channelBinding] = await Promise.all([officeResult, channelResult]);
  return Object.freeze({ office: officeBinding, channel: channelBinding });
}
