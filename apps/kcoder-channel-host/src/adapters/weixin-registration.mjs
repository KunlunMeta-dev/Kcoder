import { WeixinQrAuthorization } from './weixin.mjs';
import { normalizeWeixinQrImage } from './weixin-qr-image.mjs';

/** Translate the SDK's QR image and long-poll states to the common registration contract. */
export class WeixinRegistration {
  constructor({ authorization = new WeixinQrAuthorization(), now = Date.now } = {}) {
    this.authorization = authorization; this.now = now;
  }
  async create(signal) {
    const result = await this.authorization.create(signal);
    this.state = { state: result.state, verificationUrl: await normalizeWeixinQrImage(result.image),
      verificationKind: 'image', expiresAtMs: this.now() + 600000, intervalMs: 2000 };
    return this.state;
  }
  async poll(verifyCode) {
    let result;
    // The SDK owns the 30-second long-poll deadline; do not add a shorter outer timer.
    try { result = await this.authorization.poll(undefined, verifyCode); }
    catch (error) { if (error.code !== 'WEIXIN_QR_EXPIRED') throw error; result = { state: 'expired' }; }
    if (result.state !== 'pending') this.state = { ...this.state, state: result.state === 'confirmed' ? 'ready' : result.state };
    if (result.privateCredentials) {
      const { accountId, apiBase, botToken } = result.privateCredentials;
      this.configuration = { accountId, apiBase }; this.credentials = { botToken };
    }
    if (['ready', 'expired', 'denied', 'verification_blocked', 'already_bound'].includes(this.state.state)) delete this.state.verificationUrl;
    return this.state;
  }
  cancel() { this.authorization.cancel(); this.configuration = undefined; this.credentials = undefined; }
}
