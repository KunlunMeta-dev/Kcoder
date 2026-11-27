import { projectThreadTranscriptObservation, projectThreadTranscriptSnapshot } from './broker-thread-summary.js';

const ITEM_METHODS = new Set(['item/started', 'item/delta', 'item/completed']);
const peerInput = value => value !== null && typeof value === 'object' &&
  (value.role === 'peer_agent' || value.origin === 'peer_agent' || value.type === 'peerAgentMessage');

/** Capability only, never a permission to send or access another conversation. */
export const supportsPeerMessages = client => client?.initialized === true && client.peerAgentMessagesNegotiatedV1 === true;

/** Filter only typed transcript rows. Body text and assistant replies to a peer
 * remain ordinary content; another client's shared response is never mutated.
 */
export function projectPeerMessageHistory(message, method, supported) {
  if (supported || message?.error || !message?.result) return message;
  const filter = page => {
    if (!Array.isArray(page?.messages) || !page.messages.some(peerInput)) return page;
    return { ...page, messages: page.messages.filter(row => !peerInput(row)) };
  };
  let result = message.result;
  if (method === 'thread/read' || method === 'thread/read/indexed') result = filter(result);
  else if (method === 'thread/resume' && result.history?.status === 'ready') {
    const page = filter(result.history.page);
    if (page !== result.history.page) result = { ...result, history: { ...result.history, page } };
  }
  if (result === message.result) return message;
  // Source ordinals/cursors still name the authoritative unfiltered history.
  // Its complete transcript proof cannot describe this smaller display page.
  return projectThreadTranscriptObservation(projectThreadTranscriptSnapshot({ ...message, result }, method, false), method, false);
}

export function allowsPeerMessageNotification(message, supported) {
  return supported || !ITEM_METHODS.has(message?.method) ||
    !(peerInput(message.params?.item) || peerInput(message.params));
}
