import { AGENT_MESSAGE_RECEIPTS_CAPABILITY, AGENT_MESSAGE_REPLIES_CAPABILITY } from '../shared/agentMessageMethods.mjs';
import { ROUTER_METHODS, WAKE_READ_CAPABILITY, requireRouter } from './agent-message-router-private.js';
import { SESSION_READ_CAPABILITY } from './agent-message-router-session-read.js';

/** Feature facts only. Every use still verifies the original endpoint and ACL. */
export async function endpointFeatureCapabilities(endpoint, request) {
  endpoint.verify();
  if (typeof endpoint.requestPrivate !== 'function') {
    const values = endpoint.broker.initializeResponse?.result?.capabilities?.experimental;
    return new Set([AGENT_MESSAGE_RECEIPTS_CAPABILITY, AGENT_MESSAGE_REPLIES_CAPABILITY, SESSION_READ_CAPABILITY, WAKE_READ_CAPABILITY].filter(name => values?.[name] === true));
  }
  // The catalog broker cannot certify a separately held paired TUI process.
  let result;
  try { result = await request(endpoint, ROUTER_METHODS.capabilities, {}); }
  catch (error) { endpoint.verify(); if (error?.code === -32601) return new Set(); throw error; }
  endpoint.verify();
  requireRouter(result && Object.keys(result).length === 1 && Array.isArray(result.capabilities) &&
    result.capabilities.length <= 128 && result.capabilities.every(value => typeof value === 'string' && /^[A-Za-z0-9]{1,128}$/.test(value)) &&
    new Set(result.capabilities).size === result.capabilities.length);
  return new Set(result.capabilities);
}
