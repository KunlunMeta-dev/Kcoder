const MODES = new Set(['kcoder', 'kworker']);
const MCP_APP_METHODS = new Set(['mcp/apps/read', 'mcp/apps/resourceRead', 'mcp/apps/resourceContentRead', 'mcp/apps/toolCall', 'mcp/apps/operationRead', 'mcp/apps/revoke']);
const CAPS = ['studioWorkModesV1', 'inlineWidgetsV1', 'isolatedWidgetsV1', 'mcpAppsV1'];

/** A shared backend initialization never grants presentation to a peer client. */
export class BrokerStudioPresentation {
  #clients = new WeakMap();
  #threads = new Map();

  attach(client) { this.#clients.set(client, {}); }

  initialize(client, request) {
    const prior = this.#clients.get(client) ?? {};
    if (prior.initialized) return;
    const experimental = request.params?.capabilities?.experimental ?? {};
    this.#clients.set(client, { initialized: true,
      studioWorkModesV1: experimental.studioWorkModesV1 === true,
      inlineWidgetsV1: experimental.inlineWidgetsV1 === true,
      isolatedWidgetsV1: experimental.isolatedWidgetsV1 === true,
      mcpAppsV1: experimental.mcpAppsV1 === true });
  }

  project(response, client) {
    if (response.error || !response.result?.capabilities?.experimental) return response;
    const requested = this.#clients.get(client) ?? {};
    const experimental = { ...response.result.capabilities.experimental };
    for (const cap of CAPS) {
      if (cap in experimental) experimental[cap] = experimental[cap] === true && requested[cap] === true;
    }
    return { ...response, result: { ...response.result, capabilities: {
      ...response.result.capabilities, experimental,
    } } };
  }

  validate(client, request, backendCaps, threadOwner, sharedThreadMember = false) {
    const params = request.params ?? {};
    const declared = this.#clients.get(client) ?? {};
    const mode = params.studioWorkMode;
    const presentation = params.clientPresentation;
    if (request.method?.startsWith('mcp/apps/')) {
      if (!MCP_APP_METHODS.has(request.method)) return 'Unsupported MCP App operation';
      if (CAPS.some(cap => declared[cap] !== true || backendCaps?.[cap] !== true))
        return 'MCP Apps requires current-client Studio, inline, isolated and mcpAppsV1 negotiation';
      if (typeof params.threadId !== 'string' || !params.threadId || threadOwner !== client)
        return 'MCP App access requires a thread resumed by this Gateway client';
      if (this.#threads.get(params.threadId) !== 'kworker')
        return 'MCP Apps requires a kworker conversation';
      return null;
    }
    if (request.method?.startsWith('widget/')) {
      if (!declared.inlineWidgetsV1 || backendCaps?.inlineWidgetsV1 !== true)
        return 'inlineWidgetsV1 negotiation is required';
      const threadId = params.threadId ?? params.widget?.threadId;
      if (params.threadId !== undefined && params.widget?.threadId !== undefined &&
          params.threadId !== params.widget.threadId) return 'Widget thread identities must match';
      if (typeof threadId !== 'string' || !threadId || threadOwner !== client)
        return 'Widget access requires a thread resumed by this Gateway client';
      return null;
    }
    if (request.method === 'thread/start' && mode !== undefined) {
      if (!MODES.has(mode)) return 'Unknown Studio work mode';
      if (!declared.studioWorkModesV1 || backendCaps?.studioWorkModesV1 !== true)
        return 'studioWorkModesV1 negotiation is required';
    }
    if (!['turn/start', 'tools/catalog'].includes(request.method) || presentation === undefined) return null;
    if (!presentation || typeof presentation !== 'object' || Array.isArray(presentation) ||
        presentation.version !== 1 || Object.keys(presentation).some(key => !['version', 'studioWorkMode', 'inlineWidgets', 'isolatedWidgets'].includes(key)) ||
        (presentation.studioWorkMode !== undefined && !MODES.has(presentation.studioWorkMode)) ||
        (presentation.inlineWidgets !== undefined && typeof presentation.inlineWidgets !== 'boolean') ||
        (presentation.isolatedWidgets !== undefined && typeof presentation.isolatedWidgets !== 'boolean'))
      return 'clientPresentation requires version 1 and a valid Studio mode';
    if (!declared.studioWorkModesV1 || backendCaps?.studioWorkModesV1 !== true)
      return 'studioWorkModesV1 negotiation is required';
    if (presentation.inlineWidgets === true && (!declared.inlineWidgetsV1 || backendCaps?.inlineWidgetsV1 !== true))
      return 'inlineWidgetsV1 negotiation is required';
    if (presentation.isolatedWidgets === true && (!presentation.inlineWidgets ||
        !declared.isolatedWidgetsV1 || backendCaps?.isolatedWidgetsV1 !== true))
      return 'isolatedWidgetsV1 negotiation with inline widgets is required';
    const threadId = params.threadId;
    // A confirmed shared resume can declare presentation for its own next
    // turn or catalog read. Widget and MCP App access above stays owner-only.
    if (threadId && threadOwner !== client && !sharedThreadMember)
      return 'Studio presentation requires a thread resumed by this Gateway client';
    const boundMode = this.#threads.get(threadId);
    if (boundMode && (presentation.studioWorkMode ?? 'kcoder') !== boundMode)
      return 'Studio work mode must match the thread creation mode';
    return null;
  }

  response(method, result) {
    if (!['thread/start', 'thread/resume', 'thread/fork', 'thread/read'].includes(method)) return;
    const thread = result?.thread;
    if (typeof thread?.id === 'string') this.#threads.set(thread.id, thread.studioWorkMode === 'kworker' ? 'kworker' : 'kcoder');
  }

  deleteThread(threadId) { this.#threads.delete(threadId); }
  inlineWidgets(client) { return this.#clients.get(client)?.inlineWidgetsV1 === true; }

  notification(client, message) {
    if (this.inlineWidgets(client)) return message;
    if (message.method === 'item/event' && message.params?.event?.type === 'widget_input_preview')
      return null;
    if (message.params?.item?.widgetRef !== undefined) {
      const { widgetRef, ...item } = message.params.item;
      return { ...message, params: { ...message.params, item } };
    }
    return message;
  }
}
