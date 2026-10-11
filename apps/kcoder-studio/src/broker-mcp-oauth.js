import { createMcpOAuthCallbackReceiver } from "./mcp-oauth-callback.js";

export const MCP_OAUTH_RECEIVER = Symbol("mcpOAuthReceiver");
export const MCP_OAUTH_COMPLETION = Symbol("mcpOAuthCompletion");

// Receiver ownership follows the originating WebSocket even when the backend is shared.
export class BrokerMcpOAuth {
  constructor({ attached, forward, cancel, notify }) {
    Object.assign(this, { attached, forward, cancel, notify });
    this.tickets = new Set();
  }

  async login(client, request) {
    if (this.tickets.size >= 16) throw new Error("Too many pending browser authorizations");
    const ticket = { client, active: true, receiver: null, flowId: null };
    this.tickets.add(ticket);
    try {
      ticket.receiver = await (client.createMcpCallbackReceiver?.({ stablePath: Boolean(request.params?.clientId), waitForCompletion: true }) ?? createMcpOAuthCallbackReceiver({ waitForCompletion: true }));
      if (!ticket.active || !this.attached(client)) {
        ticket.receiver.close();
        this.tickets.delete(ticket);
        return;
      }
      void ticket.receiver.result.then(outcome => {
        if (!ticket.active) return;
        ticket.active = false;
        if (outcome.status !== "received") this.tickets.delete(ticket);
        if (!ticket.flowId || !this.attached(client)) return;
        if (outcome.status === "received") {
          this.forward(client, {
            jsonrpc: "2.0", id: null, method: "mcp/callback",
            params: { flowId: ticket.flowId, callbackUrl: outcome.callbackUrl },
            [MCP_OAUTH_COMPLETION]: ticket.flowId,
          });
        } else {
          this.cancel(ticket.flowId);
          this.notify(client, { flowId: ticket.flowId, status: outcome.status });
        }
      }).catch(() => {
        this.closeTicket(ticket);
        if (ticket.flowId) this.cancel(ticket.flowId);
        if (this.attached(client)) this.notify(client, { flowId: ticket.flowId, status: "failed" });
      });
      void ticket.receiver.completion?.then(() => { this.tickets.delete(ticket); });
      this.forward(client, {
        ...request, method: "mcp/login",
        params: { ...request.params, redirectUri: ticket.receiver.redirectUri },
        [MCP_OAUTH_RECEIVER]: ticket,
      });
    } catch (error) {
      ticket.active = false;
      ticket.receiver?.close();
      this.tickets.delete(ticket);
      throw error;
    }
  }

  response(pending, response) {
    if (pending.oauthCompletion) {
      const ticket = [...this.tickets].find(value => value.flowId === pending.oauthCompletion);
      let failureReason = "authorization_failed";
      if (ticket) {
        const message = String(response.error?.message || '');
        const reason = /OAuth credential storage failed/i.test(message) ? 'credential_storage_failed'
          : /token (exchange|endpoint)/i.test(message) ? 'token_exchange_failed'
          : /token type/i.test(message) ? 'token_type_unsupported'
          : /bearer token/i.test(message) ? 'token_syntax_invalid'
          : /token response/i.test(message) ? 'token_response_invalid'
          : /callback issuer|omitted the required issuer/i.test(message) ? 'callback_issuer_mismatch'
          : /declined by the authorization server/i.test(message) ? 'authorization_denied'
          : /flow is unavailable|no longer active/i.test(message) ? 'flow_unavailable'
          : /configuration changed/i.test(message) ? 'configuration_changed' : 'authorization_failed';
        failureReason = reason;
        const httpStatus = Number(message.match(/\bHTTP ([45]\d{2})\b/)?.[1]);
        const errorCode = message.match(/\b(invalid_grant|invalid_client|invalid_request|invalid_scope|unauthorized_client|unsupported_grant_type)\b/)?.[1];
        const diagnostic = message.match(/Invalid OAuth token response \(([^)]{1,220})\)/)?.[1];
        ticket.receiver.completeAuthorization?.({ status: response.error ? 'failed' : 'authorized', reason, httpStatus, errorCode, diagnostic });
        this.tickets.delete(ticket);
      }
      if (this.attached(pending.client)) {
        this.notify(pending.client, {
          flowId: pending.oauthCompletion,
          status: response.error ? "failed" : "authorized",
          ...(response.error ? { message: failureReason } : {}),
        });
      }
      return true;
    }
    const ticket = pending.oauthReceiver;
    if (!ticket) {
      if (!response.error && pending.method === "mcp/cancel") this.cancelReceiver(pending.params?.flowId);
      return false;
    }
    if (response.error) {
      this.closeTicket(ticket);
      return false;
    }
    const flowId = response.result?.flowId;
    try {
      if (!ticket.active || !this.attached(ticket.client) || typeof flowId !== "string") {
        throw new Error("MCP browser authorization is no longer active");
      }
      ticket.receiver.bindAuthorizationUrl(response.result.authorizationUrl);
      ticket.flowId = flowId;
    } catch {
      if (typeof flowId === "string") this.cancel(flowId);
      this.closeTicket(ticket);
      delete response.result;
      response.error = { code: -32021, message: "MCP authorization did not match its callback receiver" };
    }
    return false;
  }

  closeTicket(ticket) {
    ticket.active = false;
    ticket.receiver?.close();
    this.tickets.delete(ticket);
  }

  cancelReceiver(flowId) {
    for (const ticket of this.tickets) if (ticket.flowId === flowId) this.closeTicket(ticket);
  }

  detach(client) {
    for (const ticket of this.tickets) if (ticket.client === client) this.closeTicket(ticket);
  }

  close() {
    for (const ticket of this.tickets) this.closeTicket(ticket);
  }
}
