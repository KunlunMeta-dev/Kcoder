/** Observe actual production scrolling without changing browser scroll behavior. */
export async function observeWidgetWorkbenchScroll(page) {
  await page.addInitScript(() => {
    const calls = [];
    const identify = node => node?.getAttribute?.('data-testid') || node?.tagName || null;
    const record = (kind, node, detail) => {
      if (calls.length >= 2000) calls.shift();
      calls.push({ kind, target: identify(node), time: performance.now(),
        top: node?.scrollTop, height: node?.scrollHeight, viewport: node?.clientHeight,
        detail, stack: new Error().stack?.slice(0, 1800) });
    };
    window.__widgetScrollCalls = calls;
    for (const [prototype, name] of [[Element.prototype, 'scrollTo'], [Element.prototype, 'scrollIntoView'], [HTMLElement.prototype, 'focus']]) {
      const original = prototype[name];
      if (typeof original !== 'function') continue;
      prototype[name] = function (...args) {
        record(name, this, args.map(value => typeof value === 'object' ? value : String(value)));
        return original.apply(this, args);
      };
    }
    const top = Object.getOwnPropertyDescriptor(Element.prototype, 'scrollTop');
    if (top?.get && top?.set) Object.defineProperty(Element.prototype, 'scrollTop', {
      ...top, set(value) { record('scrollTop-set', this, value); top.set.call(this, value); },
    });
    addEventListener('scroll', event => {
      if (identify(event.target) === 'desktop-workbench-content') record('scroll-event', event.target);
    }, true);
    addEventListener('wheel', event => record('wheel-event', event.target, { x: event.deltaX, y: event.deltaY, trusted: event.isTrusted }), { capture: true, passive: true });
    addEventListener('focusin', event => record('focusin', event.target), true);
  });
}

export async function sampleCompletedWidgetScroll(page, frames = 120) {
  return page.evaluate(async count => {
    const outer = document.querySelector('[data-testid="desktop-workbench-content"]');
    if (!outer) throw new Error('Production PaneLayout external scroll owner is absent');
    const samples = [];
    for (let index = 0; index < count; index++) {
      await new Promise(resolve => requestAnimationFrame(resolve));
      samples.push({ frame: index, time: performance.now(), top: outer.scrollTop,
        height: outer.scrollHeight, viewport: outer.clientHeight,
        active: document.activeElement?.getAttribute('data-testid') || document.activeElement?.tagName,
        widgets: [...outer.querySelectorAll('[data-testid="inline-widget"]')].map(node => ({
          id: node.dataset.widgetId, top: node.getBoundingClientRect().top,
          height: node.getBoundingClientRect().height, iframe: Boolean(node.querySelector('iframe')),
          status: node.dataset.widgetStatus,
        })),
      });
    }
    return { samples, calls: window.__widgetScrollCalls ?? [],
      externalOwner: outer.dataset.testid,
      innerOverflow: getComputedStyle(document.querySelector('[data-testid="desktop-chat-scroll"]')).overflowY,
    };
  }, frames);
}

/** Preserve real RPC replies while modelling a slower HTTP/SSH artifact read. */
export async function delayWidgetContentReplies(context, page, delayMs = 450, { transcriptDelayMs = 0 } = {}) {
  const timers = new Set();
  const state = { enabled: false, delayed: 0, transcriptDelayed: 0, closed: false, threadLists: [] };
  context.addCleanup('cancel owned widget response delays', () => {
    state.closed = true;
    for (const timer of timers) clearTimeout(timer);
    timers.clear();
  });
  await page.routeWebSocket('**/rpc*', socket => {
    const upstream = socket.connectToServer();
    const contentReads = new Set();
    const threadLists = new Set();
    socket.onMessage(raw => {
      if (state.closed) return;
      let delayTranscript = false;
      try {
        const frame = JSON.parse(String(raw));
        if (frame.method === 'widget/content/read') contentReads.add(frame.id);
        if (frame.method === 'thread/list') threadLists.add(frame.id);
        delayTranscript = frame.method === 'thread/read' && transcriptDelayMs > 0;
      } catch { /* Non-JSON frames remain untouched. */ }
      if (delayTranscript) {
        state.transcriptDelayed++;
        const timer = setTimeout(() => { timers.delete(timer); if (!state.closed) upstream.send(raw); }, transcriptDelayMs);
        timers.add(timer);
        return;
      }
      upstream.send(raw);
    });
    upstream.onMessage(raw => {
      if (state.closed) return;
      try {
        const frame = JSON.parse(String(raw));
        if (threadLists.delete(frame.id)) {
          if (state.threadLists.length >= 32) state.threadLists.shift();
          state.threadLists.push({ result: frame.result, error: frame.error });
        }
      } catch { /* Non-JSON frames remain unchanged. */ }
      let content = false;
      try { content = contentReads.delete(JSON.parse(String(raw)).id); } catch { /* Forward unchanged. */ }
      if (!content || !state.enabled) { socket.send(raw); return; }
      state.delayed++;
      const timer = setTimeout(() => {
        timers.delete(timer);
        try { socket.send(raw); } catch { /* A closed owner cannot receive a late reply. */ }
      }, delayMs);
      timers.add(timer);
    });
  });
  return state;
}
