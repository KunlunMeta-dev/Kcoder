import { FeishuRegistration } from '../adapters/feishu-registration.mjs';
import { WeixinQrAuthorization } from '../adapters/weixin.mjs';
import { WeixinRegistration } from '../adapters/weixin-registration.mjs';
import { BotRegistration } from '../adapters/bot-registration.mjs';
import { QQRegistration } from '../adapters/qq-registration.mjs';
import { connectionFeatures } from '../adapters/feature-options.mjs';

const TERMINAL_STATES=new Set(['ready','saved','cancelled','expired','denied','verification_blocked','already_bound','unavailable']);
const MAX_ACTIVE_PER_OWNER=16,MAX_RETAINED_FLOWS=256,RECEIPT_RETENTION_MS=3600000;

/** Short-lived initial authentication. No connection is saved or started before explicit Commit. */
export class ChannelAuthorizations {
  constructor(store, { now = Date.now, feishu = () => new FeishuRegistration({ now }),
    weixin = () => new WeixinQrAuthorization({ now }), wecom = () => new BotRegistration('wecom', { now }),
    dingtalk = () => new BotRegistration('dingtalk', { now }), qq = () => new QQRegistration({ now }) } = {}) {
    this.store = store; this.factories = { feishu, weixin: () => new WeixinRegistration({ authorization: weixin(), now }), wecom, dingtalk, qq };
    this.flows = new Map(); this.now = now; this.closed = false;
  }
  cancel(flow,state='cancelled') {
    if(!flow.cancelled){flow.cancelled=true;flow.adapter.cancel();}
    if(!flow.saved)flow.state={state};
  }
  async request(body, owner) {
    if(this.closed)throw new Error('CHANNEL_AUTHENTICATION_CLOSED');
    if (typeof owner!=='string'||!owner||!body||typeof body!=='object'||Array.isArray(body)
      || typeof body.flowId !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(body.flowId)
      || body.verifyCode!==undefined&&(typeof body.verifyCode!=='string'||!body.verifyCode||body.verifyCode.length>128)) throw new Error('CHANNEL_AUTHENTICATION_REQUEST_INVALID');
    for (const [id, flow] of this.flows) if (flow.expiresAtMs <= this.now()&&!flow.pending) {
      if(flow.saved||flow.retiredAtMs!==undefined&&flow.retiredAtMs+RECEIPT_RETENTION_MS<=this.now())this.flows.delete(id);
      else if(flow.retiredAtMs===undefined){this.cancel(flow,'expired');flow.retiredAtMs=this.now();}
    }
    let flow = this.flows.get(body.flowId);
    if (!flow) {
      if (body.action !== 'authorization_begin' || !Object.hasOwn(this.factories, body.platform)
        || typeof body.connectionId !== 'string' || !body.connectionId || body.connectionId.length > 512
        || !Number.isSafeInteger(body.expectedRevision) || body.expectedRevision < 0) throw new Error('CHANNEL_AUTHENTICATION_FLOW_MISSING');
      const active = [...this.flows.values()].filter(row => row.owner===owner&&!row.saved
        &&(!TERMINAL_STATES.has(row.state.state)||row.state.state==='ready'));
      if (active.length >= MAX_ACTIVE_PER_OWNER || this.flows.size >= MAX_RETAINED_FLOWS) throw new Error('CHANNEL_AUTHENTICATION_CAPACITY');
      flow = { owner, platform: body.platform, connectionId: body.connectionId, expectedRevision: body.expectedRevision,
        adapter: this.factories[body.platform](), expiresAtMs: this.now() + RECEIPT_RETENTION_MS, state: { state: 'unknown' } };
      // Reserve the original ID before the platform call. Lost replies never create another application flow.
      this.flows.set(body.flowId, flow);
    }
    if (flow.owner !== owner) throw new Error('CHANNEL_AUTHENTICATION_FLOW_MISSING');
    // Interrupt owned I/O before joining the serial lane; cancellation cannot wait behind a long poll.
    if(body.action==='authorization_cancel'&&!flow.saved)this.cancel(flow);
    const previous = flow.pending ?? Promise.resolve();
    const operation = previous.catch(() => {}).then(() => this.apply(flow, body));
    flow.pending = operation;
    try { return await operation; } finally { if (flow.pending === operation) flow.pending = undefined; }
  }
  async apply(flow, body) {
    if(this.closed)throw new Error('CHANNEL_AUTHENTICATION_CLOSED');
    if (body.action === 'authorization_cancel') {
      if (!flow.saved) this.cancel(flow);
    } else if (body.action === 'authorization_begin' && !flow.started&&!flow.cancelled) {
      flow.started = true;
      try{
        const state=await flow.adapter.create(AbortSignal.timeout(15000));
        if(this.closed)throw new Error('CHANNEL_AUTHENTICATION_CLOSED');
        if(!flow.cancelled){flow.state=state;flow.created=true;}
      }catch(error){
        if(this.closed)throw new Error('CHANNEL_AUTHENTICATION_CLOSED');
        if(!flow.cancelled&&TERMINAL_STATES.has(flow.adapter.state?.state))flow.state={...flow.adapter.state};
        if(!flow.cancelled)throw error;
      }
      // Keep the original receipt long enough to observe expiry, including DingTalk's two-hour QR.
      if (Number.isSafeInteger(flow.state.expiresAtMs)) flow.expiresAtMs = Math.max(flow.expiresAtMs, flow.state.expiresAtMs + RECEIPT_RETENTION_MS);
    } else if (body.action === 'authorization_poll' && flow.created && !flow.saved && !TERMINAL_STATES.has(flow.state.state)) {
      try{
        const state=await flow.adapter.poll(body.verifyCode);
        if(this.closed)throw new Error('CHANNEL_AUTHENTICATION_CLOSED');
        if(!flow.cancelled)flow.state=state;
      }catch(error){
        if(this.closed)throw new Error('CHANNEL_AUTHENTICATION_CLOSED');
        if(!flow.cancelled)throw error;
      }
    } else if (body.action === 'authorization_commit' && !flow.saved) {
      if (flow.state.state !== 'ready') throw new Error('CHANNEL_AUTHENTICATION_NOT_READY');
      if(typeof body.label!=='string'||!body.label.trim()||body.label.trim().length>256)throw new Error('CHANNEL_AUTHENTICATION_REQUEST_INVALID');
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
  close() {
    this.closed=true;
    for (const flow of this.flows.values()) if(!flow.saved)this.cancel(flow);
    const pending=[...this.flows.values()].map(flow=>flow.pending).filter(Boolean);this.flows.clear();
    return Promise.allSettled(pending);
  }
}
