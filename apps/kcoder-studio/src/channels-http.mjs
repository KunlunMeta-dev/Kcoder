import { channelMessagePreview, publicChannelChat } from '../../kcoder-channel-host/src/channels/presentation.mjs';

const publicTarget = target => target ? { serverId: target.serverId, workspacePath: target.workspacePath, threadId: target.threadId } : null;
const publicBinding = binding => binding ? { ...binding, target: publicTarget(binding.target) } : null;
const publicError = error => /^[A-Z][A-Z0-9_]{1,100}$/.test(error?.code ?? error?.message)
  ? error.code ?? error.message : 'CHANNEL_OPERATION_FAILED';

/** Called only after the Gateway's normal login and origin checks. No separate channel permits exist. */
export function createChannelsHttpHandler({ controller, requestBody, jsonResponse, requireSameOriginMutation,
  resolveTarget, targetLabel = id => id }) {
  const { runtime } = controller, { store } = runtime;
  const connection = row => ({ ...row, hasCredential: Boolean(store.credentials(row.id)),
    state: runtime.workers.get(row.id)?.connectionState() ?? (row.enabled ? 'failed' : 'stopped') });
  return async function handle({ request, response, pathname, session, loginOwner }) {
    if (pathname !== '/api/channels') return false;
    try {
      if (request.method === 'GET') {
        const chatId = new URL(request.url ?? '/api/channels', 'http://gateway.invalid').searchParams.get('chatId');
        if (chatId !== null) {
          if (!chatId || chatId.length > 512) throw new Error('CHANNEL_CHAT_NOT_FOUND');
          const chat = store.chat(chatId);
          if (!chat || !store.connection(chat.connectionId)) throw new Error('CHANNEL_CHAT_NOT_FOUND');
          const binding = store.binding(chatId);
          let bindingInfo = null;
          if (binding) {
            try {
              const target = await resolveTarget(publicTarget(binding.target), { session, loginOwner });
              if (target.loginOwner !== binding.target.loginOwner) throw new Error('CHANNEL_TASK_TARGET_UNAVAILABLE');
              const description = await controller.describeTarget(target);
              const current = await resolveTarget(publicTarget(binding.target), { session, loginOwner });
              if (JSON.stringify(current) !== JSON.stringify(target)) throw new Error('CHANNEL_TASK_TARGET_UNAVAILABLE');
              bindingInfo = { revision: binding.revision, status: 'available', title: description.title,
                serverLabel: targetLabel(target.serverId) };
            } catch (error) {
              bindingInfo = { revision: binding.revision, status: 'unavailable', code: publicError(error) };
            }
            if (store.binding(chatId)?.revision !== binding.revision) throw new Error('CHANNEL_BINDING_CHANGED');
          }
          jsonResponse(response, 200, { chatId, bindingRevision: store.bindingRevision(chatId), bindingInfo,
            messages: store.recentInputs(chatId).map(input => ({ id: input.id, state: input.state,
              ...channelMessagePreview(input.event, 1000) })) });
          return true;
        }
        jsonResponse(response, 200, { installationId: store.installationId,
          settings: store.settings(),
          connections: store.connections().map(connection),
          chats: store.connections().flatMap(row => store.chats(row.id).map(chat => publicChannelChat(store, chat))),
        });
        return true;
      }
      if (request.method !== 'POST') { jsonResponse(response, 405, { code: 'METHOD_NOT_ALLOWED' }); return true; }
      if (!requireSameOriginMutation(request)) { jsonResponse(response, 403, { code: 'SAME_ORIGIN_JSON_REQUIRED' }); return true; }
      const body = JSON.parse(await requestBody(request, 256 * 1024));
      if (!body || typeof body !== 'object' || Array.isArray(body)) throw new Error('CHANNEL_REQUEST_INVALID');
      let result;
      if (body.action === 'settings') {
        result = store.setSettings(body.settings);
      } else if (body.action === 'rename_connection') {
        if (!Number.isSafeInteger(body.expectedRevision) || body.expectedRevision < 0 || typeof body.label !== 'string') throw new Error('CHANNEL_REQUEST_INVALID');
        result = connection(store.renameConnection(body.connectionId, body.label.trim(), body.expectedRevision));
      } else if (body.action === 'rename_chat') {
        if (!Number.isSafeInteger(body.expectedAliasRevision) || body.expectedAliasRevision < 0 || typeof body.alias !== 'string') throw new Error('CHANNEL_REQUEST_INVALID');
        result = publicChannelChat(store, store.renameChat(body.chatId, body.alias.trim(), body.expectedAliasRevision));
      } else if (body.action === 'save') {
        const current = store.connection(body.connection?.id);
        if (current && body.expectedRevision !== undefined && current.revision !== body.expectedRevision) throw new Error('CHANNEL_CONNECTION_STATE_CHANGED');
        if (runtime.workers.has(current?.id)) throw new Error('CHANNEL_CONNECTION_STOP_REQUIRED');
        result = connection(store.saveConnection(body.connection, body.credentials, body.expectedRevision));
      } else if (body.action === 'connect') {
        await runtime.connect(body.connectionId); result = connection(store.connection(body.connectionId));
      } else if (body.action === 'disconnect') {
        await runtime.disconnect(body.connectionId); result = connection(store.connection(body.connectionId));
      } else if (body.action === 'remove') {
        if (!Number.isSafeInteger(body.expectedRevision) || body.expectedRevision < 0) throw new Error('CHANNEL_CONNECTION_REVISION_REQUIRED');
        if (runtime.workers.has(body.connectionId) || runtime.starting.has(body.connectionId)) throw new Error('CHANNEL_CONNECTION_STOP_REQUIRED');
        result = store.removeConnection(body.connectionId, body.expectedRevision);
      } else if (body.action === 'bind') {
        if (!Number.isSafeInteger(body.expectedBindingRevision) || body.expectedBindingRevision < 0) throw new Error('CHANNEL_BINDING_REVISION_REQUIRED');
        const target = await resolveTarget(body.target, { session, loginOwner });
        await controller.validateTarget(target);
        result = publicBinding(runtime.bind(body.chatId, target, body.expectedBindingRevision));
      } else if (body.action === 'unbind') {
        if (!Number.isSafeInteger(body.expectedBindingRevision) || body.expectedBindingRevision < 0) throw new Error('CHANNEL_BINDING_REVISION_REQUIRED');
        runtime.unbind(body.chatId, body.expectedBindingRevision); result = { unbound: true };
      } else if (body.action === 'send') {
        if (typeof body.deliveryId !== 'string' || !body.deliveryId || body.deliveryId.length > 256
          || typeof body.text !== 'string' || !body.text || body.text.length > 16000) throw new Error('CHANNEL_MESSAGE_INVALID');
        const sent = await runtime.send(body.deliveryId, body.chatId, { text: body.text });
        result = { id: sent.id, state: sent.state, receipt: sent.receipt };
      } else if (body.action?.startsWith('authorization_')) {
        result = await controller.authorizations.request(body, loginOwner);
      } else throw new Error('CHANNEL_ACTION_UNSUPPORTED');
      if (['settings', 'bind', 'unbind', 'connect', 'disconnect', 'remove'].includes(body.action)) await controller.bindingChanged();
      jsonResponse(response, 200, result);
    } catch (error) { jsonResponse(response, 409, { code: publicError(error) }); }
    return true;
  };
}
