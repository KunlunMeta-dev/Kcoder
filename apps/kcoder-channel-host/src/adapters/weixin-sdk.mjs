import { createWeixinApi, metadata } from '../vendor/tencent-openclaw-weixin/api.mjs';
import { ChannelError, requireValue } from '../errors.mjs';
import { parseWeixinJson } from '../weixin-json.mjs';
import { silentSdkLogger } from '../transport.mjs';

export { metadata as weixinSdkMetadata };

export function checkWeixinResponse(data, endpoint = '') {
  requireValue(data && typeof data === 'object' && !Array.isArray(data), 'PLATFORM_INVALID_JSON');
  for (const key of ['ret', 'errcode']) if (data[key] !== undefined) requireValue(Number.isSafeInteger(data[key]), 'PLATFORM_INVALID_JSON');
  if ((data.ret ?? 0) !== 0 || (data.errcode ?? 0) !== 0) {
    const code = data.ret === -14 || data.errcode === -14 ? 'PLATFORM_AUTHORIZATION_FAILED'
      : endpoint === '/ilink/bot/sendmessage' && data.ret === -2 && (data.errcode ?? 0) === 0
        ? 'WEIXIN_SEND_PREPARATION_FAILED' : 'WEIXIN_PLATFORM_REJECTED';
    // A rejected conversation context does not revoke the bot's login credential.
    const error = new ChannelError(code, code === 'PLATFORM_AUTHORIZATION_FAILED' ? 'request_authorization' : 'none');
    error.externalOutcome = 'failed'; throw error;
  }
  return data;
}

/** Each official protocol client receives its own bounded transport and lifetime. */
export function createWeixinSdk({ transport, signal }) {
  return createWeixinApi({ botAgent: 'KCoder/0.1.0', logger: silentSdkLogger,
    fetch: async (url, init = {}) => {
      requireValue(typeof url === 'string' && ['GET', 'POST'].includes(init.method), 'WEIXIN_SDK_REQUEST_INVALID');
      const signals = [signal, init.signal].filter(Boolean);
      const response = await transport(url, { method: init.method, headers: init.headers,
        body: init.body === undefined ? undefined : JSON.parse(init.body),
        signal: signals.length ? AbortSignal.any(signals) : undefined,
        hosts: ['ilinkai.weixin.qq.com', 'ilink.b.qq.com'], parseJson: parseWeixinJson,
      });
      return new Response(JSON.stringify(checkWeixinResponse(response, new URL(url).pathname)), { headers: { 'Content-Type': 'application/json' } });
    },
  });
}
