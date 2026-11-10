// Independent native domains keep their own pins, full hashes and launch brands.
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { packagedNativeWindowsComponentEnvironment } from './native-component-image.mjs';

async function prepareDomain(domain, options) {
  const host = await import(pathToFileURL(join(options.resourcesPath, 'gateway', 'src',
    'integrations', domain, 'resource-host.mjs')).href);
  return host.preparePackagedConnectivityGatewayEnvironment(options);
}

/** Null means startup was cancelled; every started verifier has already settled. */
export async function preparePackagedStartupResources({
  resourcesPath, metadataPath, signal,
  readMetadata = async path => JSON.parse(await readFile(path, 'utf8')),
  channel = options => prepareDomain('connectivity', options),
  component = packagedNativeWindowsComponentEnvironment,
  warn = code => console.warn(code),
}) {
  if (signal?.aborted) return null;
  const report = code => { try { warn(code); } catch { /* Diagnostics are optional. */ } };
  const domains = [
    ['channel', channel, 'CHANNEL_NATIVE_UNAVAILABLE'],
    ['component', component, 'NATIVE_COMPONENT_IMAGE_UNAVAILABLE'],
  ];
  let appMetadata;
  try { appMetadata = await readMetadata(metadataPath); }
  catch {
    if (signal?.aborted) return null;
    for (const [, , code] of domains) report(code);
    return Object.freeze({});
  }
  if (signal?.aborted) return null;
  const options = { resourcesPath, appMetadata, signal };
  const results = await Promise.all(domains.map(async ([name, prepare, code]) => {
    try { return [name, await prepare(options)]; }
    catch { if (!signal?.aborted) report(code); return [name, undefined]; }
  }));
  // No unfinished verification is abandoned, and cancellation publishes no launch.
  if (signal?.aborted) return null;
  return Object.freeze({ ...Object.fromEntries(results),
    ...(typeof appMetadata.relayPublicUrl === 'string' ? { relayPublicUrl: appMetadata.relayPublicUrl } : {}) });
}
