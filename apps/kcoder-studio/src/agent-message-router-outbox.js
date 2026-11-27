import { isDeepStrictEqual } from 'node:util';
import { ROUTER_METHODS, AgentMessageRouterError, identityContains, messageBodySha256,
  requireRouter, requireRouterOperation, requireRouterReceipt, requireSameOperation, routerOperationId, sameAddress,
} from './agent-message-router-private.js';

/** Source Native owns the durable ledger. Node holds no body/credential file. */
export class NativeAgentMessageOutbox {
  constructor({ sourceIdentity, sourceAddress, requestSource, connectDestination, verify, onOperation }) {
    this.sourceIdentity = sourceIdentity; this.sourceAddress = sourceAddress;
    this.requestSource = requestSource; this.connectDestination = connectDestination; this.verify = verify;
    this.onOperation = onOperation;
  }
  operation(value) { return requireRouterOperation(value, this.sourceIdentity, this.sourceAddress); }
  async read(clientMessageId) {
    this.verify();
    const operationId = routerOperationId(this.sourceAddress, clientMessageId);
    const row = await this.requestSource(ROUTER_METHODS.sourceRead, { operationId });
    this.verify();
    if (row === null) return null;
    const operation = this.operation(row);
    requireRouter(operation.operationId === operationId);
    if (operation.stage !== 'prepared') { await this.onOperation?.(operation); this.verify(); }
    return operation;
  }
  async find(query) {
    this.verify();
    const row = await this.requestSource(ROUTER_METHODS.sourceFind, { sourceThreadId: this.sourceAddress.threadId, query });
    this.verify();
    if (row === null) return null;
    const operation = this.operation(row);
    requireRouter(!query.messageId || operation.receipt?.messageId === query.messageId,
      'AGENT_MESSAGES_ORIGINAL_OPERATION_UNKNOWN');
    requireRouter(!query.clientMessageId || operation.attestation.claims.clientMessageId === query.clientMessageId);
    if (operation.stage !== 'prepared') { await this.onOperation?.(operation); this.verify(); }
    return operation;
  }
  async destination(operation) {
    this.verify();
    const destination = await this.connectDestination(operation.destination);
    this.verify(); destination.verify();
    requireRouter(identityContains(destination.identity, operation.destination), 'AGENT_MESSAGES_DESTINATION_CHANGED');
    return destination;
  }
  async record(operation, destination, receipt) {
    requireRouterReceipt(receipt, operation);
    this.verify(); destination.verify();
    requireSameOperation(operation, { ...operation, stage: 'receipted', receipt });
    if (isDeepStrictEqual(operation.receipt, receipt)) return receipt;
    const next = this.operation(await this.requestSource(ROUTER_METHODS.sourceRecordReceipt,
      { operationId: operation.operationId, receipt }, destination));
    this.verify(); destination.verify();
    requireSameOperation(operation, next);
    requireRouter(next.receipt && next.receipt.messageId === receipt.messageId && next.receipt.revision >= receipt.revision);
    return next.receipt;
  }
  async reconcile(operation, destination) {
    this.verify(); destination.verify();
    const query = operation.receipt?.messageId ? { messageId: operation.receipt.messageId } :
      { clientMessageId: operation.attestation.claims.clientMessageId };
    const result = await destination.request(ROUTER_METHODS.queryOriginal, { attestation: operation.attestation, query });
    this.verify(); destination.verify();
    requireRouter(result && Object.keys(result).length === 1 && Object.hasOwn(result, 'receipt'));
    // Absence after dispatch is not evidence that the side effect never happened.
    requireRouter(result.receipt !== null, 'AGENT_MESSAGES_ORIGINAL_RECEIPT_UNKNOWN');
    return this.record(operation, destination, result.receipt);
  }
  async send(destinationAddress, message) {
    this.verify();
    const operationId = routerOperationId(this.sourceAddress, message.clientMessageId);
    let operation = await this.read(message.clientMessageId);
    const matchesIntent = row => {
      const c = row.attestation.claims;
      requireRouter(sameAddress(row.destination, destinationAddress) && row.bodySha256 === messageBodySha256(message.text) &&
        c.mode === message.mode && (c.replyToMessageId ?? null) === (message.replyToMessageId ?? null) && (c.expectedTurnId ?? null) === (message.expectedTurnId ?? null),
      'AGENT_MESSAGES_OPERATION_CONFLICT');
    };
    if (operation) matchesIntent(operation);
    const destination = await this.connectDestination(operation?.destination ?? destinationAddress);
    this.verify(); destination.verify();
    const release = destination.acquire?.();
    try {
      // An explicit send/retry rechecks the original Source admission even when
      // its stable operation already exists. It never replays a dispatched send.
      const previous = operation;
      operation = this.operation(await this.requestSource(ROUTER_METHODS.sourcePrepare, {
        operationId, sourceThreadId: this.sourceAddress.threadId, destination: destinationAddress, message,
      }, destination));
      this.verify(); destination.verify();
      requireRouter(operation.operationId === operationId); matchesIntent(operation);
      if (previous) requireSameOperation(previous, operation);
      await this.onOperation?.(operation, destination);
      this.verify(); destination.verify();
      if (operation.stage === 'receipted') return await this.reconcile(operation, destination);
      if (operation.stage === 'dispatching') return await this.reconcile(operation, destination);
      requireRouter(operation.stage === 'prepared');
      let marked;
      try {
        marked = this.operation(await this.requestSource(ROUTER_METHODS.sourceMarkDispatch, { operationId }, destination));
      } catch {
        // The mark may have reached disk. Never forward after an ambiguous mark.
        throw new AgentMessageRouterError('AGENT_MESSAGES_DISPATCH_CHECKPOINT_UNKNOWN');
      }
      this.verify(); destination.verify(); requireSameOperation(operation, marked);
      if (marked.stage === 'receipted') return await this.reconcile(marked, destination);
      requireRouter(marked.stage === 'dispatching');
      operation = marked;
      let receipt;
      try {
        receipt = await destination.request(ROUTER_METHODS.acceptForwarded, { attestation: operation.attestation, message });
      } catch {
        // Reconcile through the exact captured destination, never replay accept.
        this.verify(); destination.verify();
        return await this.reconcile(operation, destination);
      }
      this.verify(); destination.verify();
      return await this.record(operation, destination, receipt);
    } finally { release?.(); }
  }
  async get(query) {
    const operation = query.clientMessageId ? await this.read(query.clientMessageId) : await this.find(query);
    if (!operation) {
      requireRouter(!query.messageId, 'AGENT_MESSAGES_ORIGINAL_OPERATION_UNKNOWN');
      return { receipt: null };
    }
    if (operation.stage === 'prepared') return { receipt: null };
    const destination = await this.destination(operation);
    const release = destination.acquire?.();
    try { return { receipt: await this.reconcile(operation, destination) }; }
    finally { release?.(); }
  }
}
