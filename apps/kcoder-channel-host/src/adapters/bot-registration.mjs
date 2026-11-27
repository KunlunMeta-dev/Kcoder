import { platformJson } from '../transport.mjs';
import { requireValue } from '../errors.mjs';

const text = (value, max = 4096) => typeof value === 'string' && value.length > 0 && value.length <= max;
const seconds = (value, fallback, max) => Number.isSafeInteger(value) && value > 0 ? Math.min(value, max) : fallback;

// Only protocol translation varies. Timing, cancellation and private credential lifetime are shared.
const protocols = {
  wecom: {
    // @wecom/wecom-openclaw-cli 1.1.1, dist/utils/qrcode.js (WecomTeam official installer).
    origin: 'https://work.weixin.qq.com', verificationHosts: ['work.weixin.qq.com'],
    async begin(request) {
      const result = await request('/ai/qc/generate?source=wecom-cli&plat=' + ({ darwin: 1, win32: 2, linux: 3 }[process.platform] ?? 0));
      return { code: result.data?.scode, url: result.data?.auth_url, expires: 300, interval: 3 };
    },
    async poll(request, code) {
      const result = await request('/ai/qc/query_result?' + new URLSearchParams({ scode: code }));
      const data = result.data;
      requireValue(data && typeof data.status === 'string', 'WECOM_REGISTRATION_INVALID');
      if (data.status === 'success') return { state: 'ready', configuration: { botId: data.bot_info?.botid }, credentials: { secret: data.bot_info?.secret } };
      return { state: ({ expired: 'expired', denied: 'denied' })[data.status] ?? 'waiting' };
    },
  },
  dingtalk: {
    // DingTalk-Real-AI/dingtalk-openclaw-connector, src/device-auth.ts and device-auth-config.ts.
    origin: 'https://oapi.dingtalk.com', verificationHosts: ['open-dev.dingtalk.com', 'oapi.dingtalk.com'],
    async begin(request) {
      const init = await request('/app/registration/init', { source: 'DING_DWS_CLAW' });
      requireValue(init.errcode === 0 && text(init.nonce), 'DINGTALK_REGISTRATION_INVALID');
      const result = await request('/app/registration/begin', { nonce: init.nonce });
      requireValue(result.errcode === 0, 'DINGTALK_REGISTRATION_REJECTED');
      return { code: result.device_code, url: result.verification_uri_complete, expires: result.expires_in, interval: result.interval };
    },
    async poll(request, code) {
      const result = await request('/app/registration/poll', { device_code: code });
      requireValue(result.errcode === 0, 'DINGTALK_REGISTRATION_REJECTED');
      if (result.status === 'SUCCESS') return { state: 'ready', configuration: { clientId: result.client_id }, credentials: { clientSecret: result.client_secret } };
      return { state: ({ WAITING: 'waiting', FAIL: 'denied', EXPIRED: 'expired' })[result.status] ?? 'unknown' };
    },
  },
};

/** Official bot-creation device flows, independent of either platform's OpenClaw installer. */
export class BotRegistration {
  constructor(platform, { fetchImpl = fetch, now = Date.now } = {}) {
    requireValue(Object.hasOwn(protocols, platform), 'CHANNEL_AUTHENTICATION_PLATFORM_INVALID');
    this.protocol = protocols[platform]; this.fetch = fetchImpl; this.now = now;
    this.controller = new AbortController(); this.state = { state: 'creating' };
  }
  async request(path, body) {
    const result = await platformJson(this.protocol.origin + path, {
      method: body === undefined ? 'GET' : 'POST', headers: { 'Content-Type': 'application/json' }, body,
      hosts: [new URL(this.protocol.origin).hostname], fetchImpl: this.fetch, maxBytes: 64 * 1024,
      signal: AbortSignal.any([this.controller.signal, AbortSignal.timeout(15000)]),
    });
    this.controller.signal.throwIfAborted();
    requireValue(result && typeof result === 'object' && !Array.isArray(result), 'CHANNEL_AUTHENTICATION_RESPONSE_INVALID');
    return result;
  }
  async create() {
    requireValue(this.state.state === 'creating', 'CHANNEL_AUTHENTICATION_ALREADY_STARTED');
    this.state = { state: 'unknown' };
    const result = await this.protocol.begin(this.request.bind(this));
    requireValue(text(result.code) && text(result.url, 8192), 'CHANNEL_AUTHENTICATION_RESPONSE_INVALID');
    const url = new URL(result.url);
    requireValue(url.protocol === 'https:' && !url.username && !url.password && !url.port
      && this.protocol.verificationHosts.includes(url.hostname), 'CHANNEL_AUTHENTICATION_URL_INVALID');
    this.code = result.code;
    this.state = { state: 'waiting', verificationUrl: url.href,
      expiresAtMs: this.now() + seconds(result.expires, 7200, 7200) * 1000,
      intervalMs: seconds(result.interval, 3, 60) * 1000 };
    this.nextPoll = this.now() + this.state.intervalMs;
    return this.state;
  }
  async poll() {
    if (['ready', 'expired', 'denied', 'cancelled'].includes(this.state.state)) return this.state;
    if (this.now() >= this.state.expiresAtMs) { this.finish('expired'); return this.state; }
    if (this.now() < this.nextPoll) return this.state;
    requireValue(this.code, 'CHANNEL_AUTHENTICATION_NOT_READY');
    this.nextPoll = this.now() + this.state.intervalMs;
    const result = await this.protocol.poll(this.request.bind(this), this.code);
    if (result.state === 'ready') {
      requireValue(Object.values(result.configuration).every(value => text(value, 256))
        && Object.values(result.credentials).every(value => text(value)), 'CHANNEL_AUTHENTICATION_CREDENTIALS_INVALID');
      this.configuration = result.configuration; this.credentials = result.credentials;
    }
    this.state = { ...this.state, state: result.state };
    if (['ready', 'denied', 'expired'].includes(result.state)) this.finish(result.state);
    return this.state;
  }
  finish(state) { this.state = { ...this.state, state }; delete this.state.verificationUrl; this.code = undefined; }
  cancel() { this.controller.abort(); this.finish('cancelled'); this.configuration = undefined; this.credentials = undefined; }
}
