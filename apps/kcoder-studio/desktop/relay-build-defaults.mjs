import { readFileSync } from 'node:fs';
import { isolatedGatewayUrl } from '../../kcoder-relay/src/gateway-origin.mjs';

/** Only a public URL crosses into package metadata; never serialize an env object. */
export function desktopRelayBuildDefaults(env, envFile) {
  let url = env.KCODER_STUDIO_DESKTOP_RELAY_URL ?? env.KCODER_RELAY_PUBLIC_URL;
  if (url === undefined && envFile) {
    let text;
    try { text = readFileSync(envFile, 'utf8'); } catch (error) { if (error.code !== 'ENOENT') throw error; }
    const match = text?.match(/^[\t ]*KCODER_RELAY_PUBLIC_URL[\t ]*=[\t ]*(.*?)[\t ]*$/m);
    if (match) url = match[1].replace(/^(['"])(.*)\1$/, '$2');
  }
  if (!url) return {};
  let base;
  try { base = new URL(url); } catch { throw Error('Invalid public Relay URL for the desktop package'); }
  if (base.pathname !== '/' || base.search || base.hash || base.username || base.password)
    throw Error('Desktop package Relay default must be an HTTPS root URL');
  isolatedGatewayUrl(base.href, 'validation');
  return { relayPublicUrl: base.origin };
}
