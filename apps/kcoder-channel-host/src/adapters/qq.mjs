import { AsyncLocalStorage } from 'node:async_hooks';
import { TokenManager, MessageApi, MediaApi } from '@tencent-connect/qqbot-nodejs/protocol';
import { requireValue, ChannelError } from '../errors.mjs';
import { platformJson, platformBinary, EphemeralSecretStore, silentSdkLogger } from '../transport.mjs';
import { qqEvent, secretContextOrigin } from '../normalizers.mjs';
import { boundedText, stableId } from '../validation.mjs';
import { BoundedPlatformEvents } from './sdk-guards.mjs';
import { assertSdkInstalled } from '../installation.mjs';
import { qqReplySequenceLimit } from './qq-replies.mjs';
import { QQGateway } from './qq-sdk.mjs';

function acceptedResponse(data) {
 requireValue(data && typeof data === 'object' && !Array.isArray(data), 'PLATFORM_INVALID_JSON');
 if (data.code !== undefined) requireValue(Number.isSafeInteger(data.code), 'PLATFORM_INVALID_JSON');
 if (typeof data.code === 'number' && data.code !== 0) {
  const error = new ChannelError('PLATFORM_REJECTED', 'repair_configuration');
  error.externalOutcome = 'failed'; throw error;
 }
 return data;
}
export class QQAdapter {
 constructor({ configuration, credentials, transport = platformJson, GatewayClass = QQGateway,
  secretStore = new EphemeralSecretStore(), publicationResolver }) {
  this.configuration = configuration; this.credentials = credentials; this.http = transport;
  this.GatewayClass = GatewayClass; this.secrets = secretStore; this.publicationResolver = publicationResolver;
  this.events = new BoundedPlatformEvents(); this.calls = new AsyncLocalStorage();
  this.fileMaxBytes = 10 * 1024 * 1024; this.state = 'stopped'; this.loop = null;
  this.sdkCredentials = { appId: configuration.appId, clientSecret: credentials.appSecret };
  this.tokens = new TokenManager({ logger: silentSdkLogger });
  // The SDK has no injectable HTTP port for tokens. Keep its singleflight/cache,
  // supplying only KCoder's bounded, cancellable transport for this locked hook.
  requireValue(this.tokens.cache instanceof Map && typeof this.tokens.doFetchToken === 'function', 'QQ_SDK_GUARD_UNAVAILABLE');
  this.tokens.doFetchToken = async (appId, clientSecret) => {
   const signal = this.calls.getStore()?.signal ?? this.controller?.signal;
   const data = await this.http('https://bots.qq.com/app/getAppAccessToken', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: { appId, clientSecret },
    signal: AbortSignal.any([...(signal ? [signal] : []), AbortSignal.timeout(10000)]), hosts: ['bots.qq.com'] });
   signal?.throwIfAborted();
   requireValue(typeof data.access_token === 'string' && Number.isFinite(Number(data.expires_in ?? 7200)), 'PLATFORM_AUTHORIZATION_FAILED');
   this.tokens.cache.set(appId, { token: data.access_token, expiresAt: Date.now() + Number(data.expires_in ?? 7200) * 1000, appId });
   return data.access_token;
  };
  const client = { request: async (token, method, path, body) => {
   this.calls.getStore()?.signal?.throwIfAborted();
   return acceptedResponse(await this.http('https://api.sgroup.qq.com' + path, {
    method, body, headers: { Authorization: 'QQBot ' + token, 'Content-Type': 'application/json' },
    signal: this.calls.getStore()?.signal ?? this.controller?.signal, hosts: ['api.sgroup.qq.com'] }));
  } };
  this.messages = new MessageApi(client, this.tokens, { markdownSupport: false, logger: silentSdkLogger });
  this.media = new MediaApi(client, this.tokens, { logger: silentSdkLogger });
 }
 accessToken(signal) { return this.calls.run({ signal }, () => this.tokens.getAccessToken(this.configuration.appId, this.credentials.appSecret)); }
 setConnectionObserver(listener) { this.connectionObserver = listener; }
 connectionState() { return this.state; }
 observe(state) { if (this.state === state) return; this.state = state; this.connectionObserver?.(); }
 async start(ingest, { signal } = {}) {
  assertSdkInstalled('qq'); requireValue(this.configuration.appId && this.credentials.appSecret, 'AUTHORIZATION_REQUIRED');
  requireValue(!this.events.closed && !this.loop, 'CHANNEL_STOPPED');
  const controller = new AbortController(); this.controller = controller; this.observe('starting');
  let ready, reject;
  const pending = new Promise((resolve, fail) => { ready = resolve; reject = fail; });
  controller.signal.addEventListener('abort', () => reject(new ChannelError('PLATFORM_CONNECT_CANCELLED')), { once: true });
  const abort = () => { controller.abort(); reject(new ChannelError('PLATFORM_CONNECT_CANCELLED')); };
  signal?.addEventListener('abort', abort, { once: true });
  const timer = setTimeout(() => { reject(new ChannelError('PLATFORM_CONNECT_TIMEOUT')); controller.abort(); }, 15000);
  const connected = () => { if (!controller.signal.aborted) { this.observe('connected'); ready(); } };
  const receive = async packet => {
   controller.signal.throwIfAborted(); const event = qqEvent(this.configuration, packet);
   if (!event) return;
   for (let index = 0; index < event.attachments.length; index++) {
    const material = event.attachments[index], ref = stableId('qq-media', [event.botId, event.eventId, index]);
    await this.secrets.put(ref, { url: material.mediaId }, 3600000, secretContextOrigin(event)); material.mediaId = ref;
   }
   controller.signal.throwIfAborted(); await ingest(event);
  };
  this.gateway = new this.GatewayClass({ account: { accountId: this.configuration.channelId ?? this.configuration.appId, ...this.sdkCredentials },
   events: this.events, abortSignal: controller.signal, log: silentSdkLogger, intents: this.configuration.intents,
   getAccessToken: () => this.accessToken(controller.signal), clearTokenCache: () => this.tokens.clearCache(),
   getGatewayUrl: async () => {
    const address = await this.calls.run({ signal: controller.signal }, () => this.messages.getGatewayUrl(this.sdkCredentials));
    controller.signal.throwIfAborted(); const url = new URL(address);
    requireValue(url.protocol === 'wss:' && ['api.sgroup.qq.com', 'api.bot.qq.com'].includes(url.hostname) && !url.username && !url.password, 'PLATFORM_GATEWAY_INVALID');
    return url.href;
   }, onReady: connected, onResumed: connected,
   onDisconnected: ({ willReconnect }) => this.observe(willReconnect ? 'starting' : 'failed'),
   onError: () => { if (!controller.signal.aborted) this.observe('starting'); },
   onMessage: message => receive({ t: message.rawEventType, d: message.raw }),
   onRawEvent: (type, data) => receive({ t: type, d: data }),
  });
  this.loop = this.gateway.start().catch(error => {
   if (!controller.signal.aborted) this.observe(error.closeCode === 4004 ? 'authorization_required' : 'failed');
   reject(new ChannelError('PLATFORM_CONNECTION_FAILED'));
  });
  if (signal?.aborted) abort();
  try { await pending; }
  catch (error) { controller.abort(); await this.loop; if (this.state === 'starting') this.observe('degraded'); throw error; }
  finally { clearTimeout(timer); signal?.removeEventListener('abort', abort); }
 }
 async stop() {
  this.events.close(); this.controller?.abort(); await this.loop; this.loop = null;
  this.tokens.stopBackgroundRefresh(); this.tokens.clearCache(); this.observe('stopped');
 }
 validateDestination(destination) {
  try {
   requireValue(['private', 'group', 'channel'].includes(destination.chatKind) && typeof destination.conversationId === 'string' && destination.conversationId.length > 0, 'CHANNEL_DESTINATION_INVALID');
   const mode = destination.sendMode ?? (destination.replyMessageId ? 'reply' : 'proactive');
   requireValue(['reply', 'proactive'].includes(mode), 'QQ_SEND_MODE_INVALID');
   if (mode === 'proactive') return {};
   requireValue(destination.replyMessageId, 'QQ_PASSIVE_REPLY_REQUIRED', 'repair_configuration');
   requireValue(Number.isFinite(destination.replyExpiresAt) && destination.replyExpiresAt > Date.now(), 'QQ_PASSIVE_REPLY_EXPIRED', 'repair_configuration');
   requireValue(Number.isSafeInteger(destination.replySequence) && destination.replySequence > 0 && destination.replySequence <= qqReplySequenceLimit(destination), 'QQ_REPLY_LIMIT_REACHED', 'repair_configuration');
   return { msg_id: destination.replyMessageId, msg_seq: destination.replySequence };
  } catch (error) { error.externalOutcome = 'failed'; throw error; }
 }
 async sendBody(destination, body, signal) {
  const reply = this.validateDestination(destination), content = { ...body, ...reply };
  return this.calls.run({ signal }, async () => {
   let result;
   if (destination.platformRoute === 'qq_guild_dm') result = await this.messages.sendDmMessageRaw(destination.conversationId, this.sdkCredentials, content);
   else if (destination.chatKind === 'channel') result = await this.messages.sendChannelMessageRaw(destination.conversationId, this.sdkCredentials, content);
   else {
    const scope = destination.chatKind === 'group' ? 'group' : 'c2c';
    if (!reply.msg_id && body.msg_type === 0) result = await this.messages.sendProactiveMessage(scope, destination.conversationId, body.content, this.sdkCredentials);
    else result = await this.messages.sendRaw(scope, destination.conversationId, this.sdkCredentials, content);
   }
   acceptedResponse(result); requireValue(typeof result.id === 'string', 'PLATFORM_RECEIPT_MISSING');
   return { state: 'accepted', messageId: result.id };
  });
 }
 async send(payload, { signal } = {}) {
  return this.sendBody(payload.destination, { content: boundedText(String(payload.content.text ?? ''), 16000), msg_type: 0 }, signal);
 }
 async download(media,{signal}={}){
  const hosts=this.credentials.allowedMediaHosts??['multimedia.nt.qq.com.cn','gchat.qpic.cn','qqbotthumb.qpic.cn'];
  const context=await this.secrets.get(media.mediaId);
  return {...await platformBinary(context.url,{signal,hosts}),filename:media.filename};
 }
 async prepareUpload(file,{artifactRef,destination,signal}){
  this.validateDestination(destination);requireValue(['private','group'].includes(destination.chatKind)&&!destination.platformRoute,'QQ_CHANNEL_MEDIA_UNAVAILABLE','explicit_user_decision');
  const mediaKind={'image/png':1,'image/jpeg':1,'video/mp4':2,'audio/silk':3}[file.mediaType];
  requireValue(mediaKind,'QQ_FILE_TYPE_UNAVAILABLE','explicit_user_decision');
  requireValue(typeof this.publicationResolver==='function','QQ_LOCAL_MEDIA_PUBLICATION_REQUIRED','explicit_user_decision');
  const publication=await this.publicationResolver({artifactRef,destination,sha256:file.sha256,signal});
  requireValue(publication?.artifactRef?.id===artifactRef.id&&publication.artifactRef.revision===artifactRef.revision&&publication.sha256===file.sha256&&publication.expiresAt>Date.now()&&typeof publication.url==='string','QQ_PUBLICATION_REFERENCE_INVALID','request_authorization');
  const url=new URL(publication.url);requireValue(url.protocol==='https:'&&!url.username&&!url.password&&!['localhost','127.0.0.1','[::1]'].includes(url.hostname),'QQ_PUBLICATION_REFERENCE_INVALID');return {url:url.href,mediaKind};
 }
 async upload(_file, { deliveryId, destination, uploadContext, signal }) {
  requireValue(uploadContext, 'QQ_LOCAL_MEDIA_PUBLICATION_REQUIRED', 'explicit_user_decision');
  const result = await this.calls.run({ signal }, () => this.media.uploadMedia(destination.chatKind === 'group' ? 'group' : 'c2c',
   destination.conversationId, uploadContext.mediaKind, this.sdkCredentials, { url: uploadContext.url, srvSendMsg: false }));
  acceptedResponse(result); requireValue(typeof result.file_info === 'string' && Number.isFinite(result.ttl), 'PLATFORM_UPLOAD_RECEIPT_MISSING');
  const handleRef = stableId('qq-upload', [deliveryId]);
  const origin = secretContextOrigin({ botId: this.configuration.appId, tenantId: destination.tenantId ?? this.configuration.tenantId ?? 'default',
   senderId: destination.externalSubjectId, conversationId: destination.conversationId, chatKind: destination.chatKind,
   eventId: destination.replyMessageId ?? deliveryId, occurredAtMs: Date.now() });
  await this.secrets.put(handleRef, { fileInfo: result.file_info, chatKind: destination.chatKind }, result.ttl > 0 ? Math.min(result.ttl * 1000, 24 * 3600000) : 24 * 3600000, origin);
  return { handleRef };
 }
 async sendFile(payload, handle, { signal } = {}) {
  const data = await this.secrets.get(handle.handleRef); requireValue(data.chatKind === payload.destination.chatKind, 'QQ_MEDIA_ROUTE_MISMATCH');
  return this.sendBody(payload.destination, { content: ' ', msg_type: 7, media: { file_info: data.fileInfo } }, signal);
 }
}
