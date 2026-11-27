import definitions from '../channel-platforms.json' with { type: 'json' };
import { prepareQqDestination } from './qq-replies.mjs';
import { weixinContextTtl } from './weixin-context.mjs';

/** SDK capabilities in the catalog are distinct from end-to-end runtime support. */
export function channelPlatform(platform) {
  if (!Object.hasOwn(definitions, platform)) throw new Error('CHANNEL_PLATFORM_UNSUPPORTED');
  return definitions[platform];
}

/**
 * @typedef {object} ChannelAdapter
 * @property {(ingest: (event: object) => Promise<object>, options?: {signal?: AbortSignal}) => Promise<void>} start
 *   Resolve only after authenticated transport readiness. Await durable ingest before ACK/cursor advancement.
 * @property {() => Promise<void>} stop Cancel and join owned work without touching peer connections.
 * @property {(payload: object, options: {deliveryId: string, signal: AbortSignal}) => Promise<object>} send
 *   Return an accepted platform receipt. Throw with externalOutcome=failed only for a definite non-send.
 *   Missing receipts remain unknown; the adapter must never replay a send or change its destination/mode.
 * @property {() => string} connectionState
 * @property {(listener: () => void) => void} setConnectionObserver
 * @property {(() => Promise<void>)=} reconnect Recover receiving only; never replay model input or output.
 */

/** Required lifecycle and delivery methods; optional reconnection stays SDK-owned. @returns {ChannelAdapter} */
export function assertChannelAdapter(adapter) {
  if (!adapter || ['start', 'stop', 'send', 'connectionState', 'setConnectionObserver']
    .some(method => typeof adapter[method] !== 'function')
    || adapter.reconnect !== undefined && typeof adapter.reconnect !== 'function') {
    throw new Error('CHANNEL_ADAPTER_CONTRACT_INVALID');
  }
  return adapter;
}

// Pure platform policies run before persistence; they never start SDKs or send.
const policies = {
  qq: { prepareDestination: prepareQqDestination },
  weixin: { contextTtl: weixinContextTtl },
};
export function prepareChannelDestination(platform, destination, context) {
  channelPlatform(platform);
  return policies[platform]?.prepareDestination?.(destination, context) ?? destination;
}
export function channelContextTtl(platform, value, ttlMs) {
  channelPlatform(platform);
  return policies[platform]?.contextTtl ? policies[platform].contextTtl(value, ttlMs) : ttlMs;
}
