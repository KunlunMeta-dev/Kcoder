import assert from 'node:assert/strict';

/** A single owned page loses one original history reply. Every frame is sent
 * unchanged to the real Gateway; no Native permission result is synthesized.
 */
export async function armPeerReadTransportFault(page, sourceThreadId) {
  assert.match(sourceThreadId, /^[A-Za-z0-9_-]{1,128}$/);
  let fault = null;
  await page.routeWebSocket(url => url.pathname.endsWith('/rpc'), browser => {
    const server = browser.connectToServer();
    let selectedRequestId;
    server.onMessage(message => {
      let frame;
      try { frame = JSON.parse(typeof message === 'string' ? message : message.toString('utf8')); }
      catch { browser.send(message); return; }
      if (selectedRequestId !== undefined && frame.id === selectedRequestId) {
        fault.originalReplyObserved = true;
        fault.originalReplyHadError = Boolean(frame.error);
        fault.replyDropped = true;
        void browser.close({ code: 1011, reason: 'Owned original history read response lost' });
        void server.close({ code: 1011, reason: 'Owned original history read response lost' });
        return;
      }
      browser.send(message);
    });
    browser.onMessage(message => {
      let frame;
      try { frame = JSON.parse(typeof message === 'string' ? message : message.toString('utf8')); }
      catch { server.send(message); return; }
      const selected = !fault && ['thread/read', 'thread/read/indexed'].includes(frame?.method)
        && frame.params?.threadId === sourceThreadId;
      if (selected) {
        selectedRequestId = frame.id;
        fault = { method: frame.method, threadId: sourceThreadId, requestForwardedUnchanged: true,
          outcome: 'read_response_unconfirmed', noSyntheticNativeReply: true,
          originalReplyObserved: false, replyDropped: false };
      }
      server.send(message);
    });
  });
  return () => fault && { ...fault };
}
