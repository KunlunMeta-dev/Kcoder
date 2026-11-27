/** HTTP stays local by default; public clients use the Relay ingress. */
export function gatewayListenHost(env = process.env) {
  return env.KCODER_STUDIO_HOST || '127.0.0.1';
}
