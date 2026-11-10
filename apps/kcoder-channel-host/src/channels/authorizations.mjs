import { FeishuRegistration } from '../adapters/feishu-registration.mjs';
import { WeixinQrAuthorization } from '../adapters/weixin.mjs';
import { WeixinRegistration } from '../adapters/weixin-registration.mjs';
import { BotRegistration } from '../adapters/bot-registration.mjs';
import { QQRegistration } from '../adapters/qq-registration.mjs';
import { connectionFeatures } from '../adapters/feature-options.mjs';

/** Short-lived initial authentication. No connection is saved or started before explicit Commit. */
export class ChannelAuthorizations {
  constructor(store, { now = Date.now, feishu = () => new FeishuRegistration({ now }),
    weixin = () => new WeixinQrAuthorization({ now }), wecom = () => new BotRegistration('wecom', { now }),
    dingtalk = () => new BotRegistration('dingtalk', { now }), qq = () => new QQRegistration({ now }) } = {}) {
    this.store = store; this.factories = { feishu, weixin: () => new WeixinRegistration({ authorization: weixin(), now }), wecom, dingtalk, qq };
    this.flows = new Map(); this.now = now;
  }
  async request(body, owner) {
    if (!owner || typeof body.flowId !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(body.flowId)) throw new Error('CHANNEL_AUTHENTICATION_REQUEST_INVALID');
    for (const [id, flow] of this.flows) if (flow.expiresAtMs < this.now()) {
      flow.adapter.cancel(); this.flows.delete(id);
    }
    let flow = this.flows.get(body.flowId);
    if (!flow) {
      if (body.action !== 'authorization_begin' || !Object.hasOwn(this.factories, body.platform)
        || typeof body.connectionId !== 'string' || !body.connectionId || body.connectionId.length > 512
        || !Number.isSafeInteger(body.expectedRevision) || body.expectedRevision < 0) throw new Error('CHANNEL_AUTHENTICATION_FLOW_MISSING');
      const active = [...this.flows.values()].filter(row => !row.saved && !['cancelled', 'expired', 'denied'].includes(row.state.state));
      if (active.length >= 16 || this.flows.size >= 256) throw new Error('CHANNEL_AUTHENTICATION_CAPACITY');
      flow = { owner, platform: body.platform, connectionId: body.connectionId, expectedRevision: body.expectedRevision,
        adapter: this.factories[body.platform](), expiresAtMs: this.now() + 3600000, state: { state: 'unknown' } };
      // Reserve the original ID before the platform call. Lost replies never create another application flow.
      this.flows.set(body.flowId, flow);
    }
    if (flow.owner !== owner) throw new Error('CHANNEL_AUTHENTICATION_FLOW_MISSING');
    const previous = flow.pending ?? Promise.resolve();
    const operation = previous.catch(() => {}).then(() => this.apply(flow, body));
    flow.pending = operation;
    try { return await operation; } finally { if (flow.pending === operation) flow.pending = undefined; }
  }
  async apply(flow, body) {
    if (body.action === 'authorization_cancel') {
      if (!flow.saved) { flow.adapter.cancel(); flow.state = { state: 'cancelled' }; }
    } else if (body.action === 'authorization_begin' && !flow.started) {
      flow.started = true;
      flow.state = await flow.adapter.create(AbortSignal.timeout(15000));
      // Keep the original receipt long enough to observe expiry, including DingTalk's two-hour QR.
      if (Number.isSafeInteger(flow.state.expiresAtMs)) flow.expiresAtMs = Math.max(flow.expiresAtMs, flow.state.expiresAtMs + 3600000);
    } else if (body.action === 'authorization_poll' && !flow.saved && !['ready', 'cancelled', 'expired', 'denied'].includes(flow.state.state)) {
      flow.state = await flow.adapter.poll(body.verifyCode);
    } else if (body.action === 'authorization_commit' && !flow.saved) {
      if (flow.state.state !== 'ready' || typeof body.label !== 'string' || !body.label.trim()) throw new Error('CHANNEL_AUTHENTICATION_NOT_READY');
      const current = this.store.connection(flow.connectionId);
      if ((current?.revision ?? 0) !== flow.expectedRevision || current?.enabled) throw new Error('CHANNEL_CONNECTION_STATE_CHANGED');
      const { configuration, credentials } = flow.adapter;
      if (!configuration || !credentials) throw new Error('CHANNEL_AUTHENTICATION_NOT_READY');
      const features = body.features === undefined ? undefined : connectionFeatures(flow.platform, body.features);
      const saved = this.store.saveConnection({ id: flow.connectionId, platform: flow.platform, label: body.label.trim(),
        configuration: { ...configuration, ...(features ? { features } : {}) } }, credentials, flow.expectedRevision);
      flow.saved = { id: saved.id, revision: saved.revision };
      flow.adapter.cancel();
      flow.state = { state: 'saved' };
    } else if (!['authorization_read', 'authorization_begin', 'authorization_commit', 'authorization_poll'].includes(body.action)) {
      throw new Error('CHANNEL_AUTHENTICATION_ACTION_INVALID');
    }
    return { flowId: body.flowId, ...flow.state, ...(flow.saved ? { connection: flow.saved } : {}) };
  }
  close() { for (const flow of this.flows.values()) flow.adapter.cancel(); this.flows.clear(); }
}
