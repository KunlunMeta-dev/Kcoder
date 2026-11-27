import { GatewayConnection } from '@tencent-connect/qqbot-nodejs/protocol';
import { ChannelError, requireValue } from '../errors.mjs';
import { PLATFORM_FRAME_BYTES } from './sdk-guards.mjs';

/** Guards for the locked SDK: persist ingress before advancing its RESUME cursor. */
export class QQGateway extends GatewayConnection {
  constructor({ events, ...options }) {
    super({ ...options,
      onMessage: message => {
        const delivery = Promise.resolve().then(() => options.onMessage(message));
        this.deliveries.push(delivery); return delivery;
      },
      onRawEvent: (type, data) => {
        const delivery = Promise.resolve().then(() => options.onRawEvent?.(type, data));
        this.deliveries.push(delivery); return delivery;
      },
      onReady: data => { this.ready = { data, resumed: false, socket: this.currentWs }; },
      onResumed: data => { this.ready = { data, resumed: true, socket: this.currentWs }; },
    });
    this.events = events;
    this.callbacks = options;
    this.deliveries = [];
    this.heartbeatPending = new WeakSet();
    this.failedSockets = new WeakSet();
  }

  openSocket(url, token) {
    this.ready = undefined;
    super.openSocket(url, token);
    this.guardSocket(this.currentWs);
  }

  guardSocket(socket) {
    const bound = () => {
      if (socket !== this.currentWs || this.isAborted) { socket.terminate(); return; }
      try {
        requireValue(socket._receiver && Number.isFinite(socket._receiver._maxPayload), 'QQ_SDK_GUARD_UNAVAILABLE');
        socket._receiver._maxPayload = PLATFORM_FRAME_BYTES;
      } catch {
        this.failedSockets.add(socket);
        this.finish(new ChannelError('QQ_SDK_GUARD_UNAVAILABLE', 'repair_configuration'));
        if (socket === this.currentWs) socket.terminate();
      }
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
        this.deliveries = [];
        const previousSession = this.sessionId;
        // The SDK normally advances lastSeq before its asynchronous callback.
        super.handlePayload(socket, { ...packet, s: undefined }, token);
        await Promise.all(this.deliveries);
        if (socket !== this.currentWs || this.opts.abortSignal.aborted) {
          if (this.ready?.socket === socket) this.ready = undefined;
          return;
        }
        if (Number.isSafeInteger(packet.s) && packet.s >= 0)
          this.lastSeq = this.sessionId !== previousSession || !Number.isSafeInteger(this.lastSeq)
            ? packet.s : Math.max(this.lastSeq, packet.s);
        if (this.ready) {
          const ready = this.ready; this.ready = undefined;
          if (ready.socket === socket) (ready.resumed ? this.callbacks.onResumed : this.callbacks.onReady)?.(ready.data);
        }
      } catch (error) {
        // Mark failure before the event queue can start its next item.
        this.failedSockets.add(socket); socket.terminate(); throw error;
      }
    }).catch(() => { this.failedSockets.add(socket); socket.terminate(); });
  }
}
