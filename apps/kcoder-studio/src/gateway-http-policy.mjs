import { randomUUID } from 'node:crypto';
import { productAccountIssuer } from './gateway-product-account.js';

export function beginGatewayResponse(request, response, publicOrigins) {
  const requestId = randomUUID();
  response.setHeader('x-request-id', requestId);
  response.setHeader('referrer-policy', 'no-referrer');
  response.setHeader('x-content-type-options', 'nosniff');
  // Only the actual TLS socket or an explicitly configured HTTPS authority is trusted.
  if (request.socket.encrypted || [...publicOrigins].some(origin => {
    const url = new URL(origin); return url.protocol === 'https:' && url.host === request.headers.host;
  })) response.setHeader('strict-transport-security', 'max-age=31536000');
  return requestId;
}

function allowedOrigins(value = '') {
  return value.split(',').map(item => item.trim()).filter(Boolean).map(item => {
    const url = new URL(item);
    if (!['https:', 'http:', 'wss:', 'ws:'].includes(url.protocol) || url.username || url.password
      || url.pathname !== '/' || url.search || url.hash) throw new Error('CSP origins must be explicit HTTP(S) or WS(S) origins');
    return url.origin;
  });
}

export function gatewayContentSecurityPolicy(env = process.env) {
  const configured = allowedOrigins([env.KCODER_STUDIO_CSP_CONNECT_ORIGINS, env.KCODER_STUDIO_PUBLIC_ORIGINS,
    env.KCODER_STUDIO_MOBILE_WEB_ORIGINS].filter(Boolean).join(','));
  const connect = new Set(configured.flatMap(origin => {
    const socket = new URL(origin);
    if (socket.protocol === 'https:') socket.protocol = 'wss:';
    else if (socket.protocol === 'http:') socket.protocol = 'ws:';
    return [origin, socket.origin];
  }));
  const accountOrigin = productAccountIssuer(env);
  if (accountOrigin) connect.add(accountOrigin);
  const frames = allowedOrigins(env.KCODER_STUDIO_CSP_FRAME_ORIGINS);
  return ["default-src 'self'", "base-uri 'none'", "object-src 'none'", "frame-ancestors 'none'", "form-action 'self'",
    "script-src 'self' 'wasm-unsafe-eval' 'sha256-67fhrP0+BkBqmgGGXTtgiVO/9EQs3QruYNU/7fnRkI8='",
    "style-src 'self' 'unsafe-inline'", "img-src 'self' data: blob: https:", "font-src 'self' data:",
    `connect-src 'self' ${[...connect].join(' ')}`.trim(), "worker-src 'self' blob:",
    `frame-src 'self' ${frames.join(' ')}`.trim(), "media-src 'self' blob: https:"].join('; ');
}

export const loginContentSecurityPolicy = "default-src 'none'; script-src 'self'; style-src 'unsafe-inline'; img-src 'self'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'; object-src 'none'";
