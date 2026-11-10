import { boundedJson } from '../transport.mjs';
import { requireValue } from '../errors.mjs';

const FEISHU = 'https://accounts.feishu.cn', LARK = 'https://accounts.larksuite.com';

/** The official PersonalAgent registration flow; only the initial authentication uses this API. */
export class FeishuRegistration {
  constructor({ fetchImpl = fetch, now = Date.now } = {}) {
    this.fetch = fetchImpl; this.now = now; this.domain = FEISHU; this.switched = false;
    this.controller = new AbortController();
    this.state = { state: 'creating', expiresAtMs: now() + 600000, intervalMs: 5000 };
  }
  async post(fields) {
    const response = await this.fetch(`${this.domain}/oauth/v1/app/registration`, {
      method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams(fields), redirect: 'error',
      signal: AbortSignal.any([this.controller.signal, AbortSignal.timeout(15000)]),
    });
    requireValue(response.status >= 200 && response.status < 500, 'FEISHU_REGISTRATION_RESPONSE_UNKNOWN');
    return boundedJson(response, 64 * 1024);
  }
  async create() {
    requireValue(this.state.state === 'creating', 'FEISHU_REGISTRATION_ALREADY_STARTED');
    this.state.state = 'unknown';
    const init = await this.post({ action: 'init' });
    requireValue(init.supported_auth_methods?.includes('client_secret'), 'FEISHU_REGISTRATION_UNAVAILABLE');
    const begin = await this.post({ action: 'begin', archetype: 'PersonalAgent', auth_method: 'client_secret', request_user_info: 'open_id' });
    requireValue(typeof begin.device_code === 'string' && begin.device_code.length > 0 && begin.device_code.length <= 4096, 'FEISHU_REGISTRATION_INVALID');
    const url = new URL(begin.verification_uri_complete);
    requireValue(url.protocol === 'https:' && !url.username && !url.password && !url.port
      && ['open.feishu.cn', 'open.larksuite.com', 'accounts.feishu.cn', 'accounts.larksuite.com'].includes(url.hostname), 'FEISHU_REGISTRATION_INVALID');
    for (const key of ['from', 'tp', 'source', 'desc', 'createOnly']) url.searchParams.delete(key);
    url.searchParams.set('from', 'sdk'); url.searchParams.set('tp', 'sdk');
    url.searchParams.set('source', 'python-sdk/kcoder'); url.searchParams.set('createOnly', 'true');
    this.deviceCode = begin.device_code;
    const intervalMs = (Number.isSafeInteger(begin.interval) ? Math.min(60, Math.max(1, begin.interval)) : 5) * 1000;
    this.state = { state: 'waiting', verificationUrl: url.href, intervalMs,
      expiresAtMs: this.now() + (Number.isSafeInteger(begin.expires_in) ? Math.max(1, Math.min(3600, begin.expires_in)) : 600) * 1000 };
    this.nextPoll = this.now() + intervalMs;
    return this.state;
  }
  async poll() {
    if (['ready', 'denied', 'expired', 'cancelled'].includes(this.state.state)) return this.state;
    if (this.now() >= this.state.expiresAtMs) { this.finish('expired'); return this.state; }
    if (this.now() < this.nextPoll) return this.state;
    requireValue(this.deviceCode, 'FEISHU_REGISTRATION_RESPONSE_UNKNOWN');
    const result = await this.post({ action: 'poll', device_code: this.deviceCode });
    this.controller.signal.throwIfAborted();
    this.nextPoll = this.now() + this.state.intervalMs;
    if (typeof result.client_id === 'string' && result.client_id.length > 0 && result.client_id.length <= 256
      && typeof result.client_secret === 'string' && result.client_secret.length > 0 && result.client_secret.length <= 4096) {
      this.configuration = { appId: result.client_id }; this.credentials = { appSecret: result.client_secret };
      this.finish('ready'); this.state.appId = result.client_id;
    } else if (result.user_info?.tenant_brand === 'lark' && !this.switched) {
      this.domain = LARK; this.switched = true; this.nextPoll = 0;
    } else if (result.error === 'slow_down') {
      this.state.intervalMs = Math.min(this.state.intervalMs + 5000, 60000);
      this.nextPoll = this.now() + this.state.intervalMs;
    } else if (['access_denied', 'expired_token'].includes(result.error)) {
      this.finish(result.error === 'access_denied' ? 'denied' : 'expired');
    } else if (result.error !== 'authorization_pending') this.state.state = 'unknown';
    return this.state;
  }
  finish(state) { this.state = { ...this.state, state }; delete this.state.verificationUrl; this.deviceCode = undefined; }
  cancel() {
    this.controller.abort(); this.finish('cancelled'); this.credentials = undefined; this.configuration = undefined;
  }
}
