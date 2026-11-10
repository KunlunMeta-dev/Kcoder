import { GatewayConnection } from '@tencent-connect/qqbot-nodejs/protocol';
import { requireValue } from '../errors.mjs';
import { PLATFORM_FRAME_BYTES } from './sdk-guards.mjs';

/** Guards for the locked SDK: persist ingress before advancing its RESUME cursor. */
export class QQGateway extends GatewayConnection {
  constructor({ events, ...options }) {
    super({ ...options,
      onMessage: message => (this.delivery = Promise.resolve().then(() => options.onMessage(message))),
      onRawEvent: (type, data) => (this.delivery = Promise.resolve().then(() => options.onRawEvent?.(type, data))),
      onReady: data => { this.ready = { data, resumed: false }; },
      onResumed: data => { this.ready = { data, resumed: true }; },
    });
    this.events = events;
    this.callbacks = options;
    this.heartbeatPending = new WeakSet();
    this.failedSockets = new WeakSet();
  }

  openSocket(url, token) {
    super.openSocket(url, token);
    this.guardSocket(this.currentWs);
  }

  guardSocket(socket) {
    const bound = () => {
      requireValue(socket._receiver && Number.isFinite(socket._receiver._maxPayload), 'QQ_SDK_GUARD_UNAVAILABLE');
      socket._receiver._maxPayload = PLATFORM_FRAME_BYTES;
    };
    if (socket._receiver) bound();
    else socket.prependOnceListener('open', bound);
    const send = socket.send.bind(socket);
    socket.send = (raw, ...args) => {
      if (JSON.parse(raw).op === 1) {
        if (this.heartbeatPending.has(socket)) { socket.terminate(); return; }
        this.heartbeatPending.add(socket);
      }
      return send(raw, ...args);
    };
  }

  handlePayload(socket, packet, token) {
    if (packet.op === 11) this.heartbeatPending.delete(socket);
    if (packet.op === 10) {
      const interval = packet.d?.heartbeat_interval;
      if (!Number.isFinite(interval) || interval < 1000 || interval > 120000) { socket.terminate(); return; }
    }
    if (packet.op !== 0) return super.handlePayload(socket, packet, token);
    void this.events.run(async () => {
      if (socket !== this.currentWs || this.failedSockets.has(socket)) return;
      try {
        this.delivery = undefined;
        // The SDK normally advances lastSeq before its asynchronous callback.
        super.handlePayload(socket, { ...packet, s: undefined }, token);
        await this.delivery;
        if (socket !== this.currentWs || this.opts.abortSignal.aborted) return;
        if (Number.isSafeInteger(packet.s)) this.lastSeq = packet.s;
        if (this.ready) {
          const ready = this.ready; this.ready = undefined;
          (ready.resumed ? this.callbacks.onResumed : this.callbacks.onReady)?.(ready.data);
        }
      } catch (error) {
        // Mark failure before the event queue can start its next item.
        this.failedSockets.add(socket); socket.terminate(); throw error;
      }
    }).catch(() => { this.failedSockets.add(socket); socket.terminate(); });
  }
}
