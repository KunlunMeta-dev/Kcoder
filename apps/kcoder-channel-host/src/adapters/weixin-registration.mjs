import { WeixinQrAuthorization,WEIXIN_QR_TTL_MS } from './weixin.mjs';
import { normalizeWeixinQrImage } from './weixin-qr-image.mjs';
import { requireValue } from '../errors.mjs';

const TERMINAL_STATES = new Set(['ready', 'expired', 'denied', 'cancelled', 'verification_blocked', 'already_bound']);

/** Translate the SDK's QR image and long-poll states to the common registration contract. */
export class WeixinRegistration {
  constructor({ authorization = new WeixinQrAuthorization(), now = Date.now } = {}) {
    this.authorization = authorization; this.now = now;
    this.state = { state: 'creating' };
  }
  async create(signal) {
    requireValue(this.state.state === 'creating', 'WEIXIN_QR_ALREADY_STARTED');
    this.state = { state: 'unknown' };
    const result = await this.authorization.create(signal);
    let verificationUrl;
    try { verificationUrl = await normalizeWeixinQrImage(result.image); }
    catch (error) { this.cancel(); throw error; }
    requireValue(this.state.state !== 'cancelled', 'WEIXIN_QR_CANCELLED');
    this.state = { state: result.state, verificationUrl,
      verificationKind: 'image', expiresAtMs: result.expiresAtMs??this.authorization.expiresAt??this.now()+WEIXIN_QR_TTL_MS, intervalMs: 2000 };
    return this.state;
  }
  async poll(verifyCode) {
    if (TERMINAL_STATES.has(this.state.state)) return this.state;
    requireValue(this.state.state !== 'creating', 'WEIXIN_QR_NOT_STARTED');
    let result;
    // The SDK owns the 30-second long-poll deadline; do not add a shorter outer timer.
    try { result = await this.authorization.poll(undefined, verifyCode); }
    catch (error) { if(this.state.state==='cancelled')return this.state;if (error?.code !== 'WEIXIN_QR_EXPIRED') throw error; result = { state: 'expired' }; }
    if (result.state !== 'pending') this.state = { ...this.state, state: result.state === 'confirmed' ? 'ready' : result.state };
    if (result.privateCredentials) {
      const { accountId, apiBase, botToken } = result.privateCredentials;
      this.configuration = { accountId, apiBase }; this.credentials = { botToken };
    }
    if (TERMINAL_STATES.has(this.state.state)) delete this.state.verificationUrl;
    return this.state;
  }
  cancel() {
    this.authorization.cancel(); this.configuration = undefined; this.credentials = undefined;
    this.state = { ...this.state, state: 'cancelled' }; delete this.state.verificationUrl;
  }
}
