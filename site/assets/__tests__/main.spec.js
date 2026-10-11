// Test contract for assets/main.js
//
// Execute the production script against owned DOM boundaries with node --test.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import test from 'node:test';

const source = readFileSync(new URL('../main.js', import.meta.url), 'utf8');

function harness({ observer = true } = {}) {
  const listeners = new Map(), selected = new Map(), scrolls = [], history = [], observed = [];
  const links = ['#features', '#architecture', '#', '#missing'].map(href => ({
    getAttribute: () => href,
    addEventListener: (event, callback) => listeners.set(href, callback),
    classList: { toggle: (name, active) => selected.set(href, { name, active }) },
  }));
  const sections = new Map(['features', 'architecture'].map(id => [id, {
    id, getBoundingClientRect: () => ({ top: 300 }),
  }]));
  let callback;
  class Observer {
    constructor(value) { callback = value; }
    observe(element) { observed.push(element.id); }
  }
  const window = { scrollY: 100, scrollTo: value => scrolls.push(value) };
  if (observer) window.IntersectionObserver = Observer;
  runInNewContext(source, {
    window, IntersectionObserver: Observer,
    history: { replaceState: (...args) => history.push(args) },
    document: {
      querySelectorAll: selector => selector.startsWith('.primary-nav') ? links.slice(0, 2) : links,
      querySelector: () => ({ offsetHeight: 64 }),
      getElementById: id => sections.get(id),
    },
  });
  return { listeners, selected, scrolls, history, observed, callback, sections };
}

test('navigation follows visible sections and observes real targets', () => {
  const h = harness();
  assert.deepEqual(h.observed, ['features', 'architecture']);
  h.callback([{ target: h.sections.get('architecture'), isIntersecting: true }]);
  assert.equal(h.selected.get('#architecture').active, true);
  assert.equal(h.selected.get('#features').active, false);
});

test('anchor scroll accounts for sticky header and preserves the hash', () => {
  const h = harness();
  let prevented = false;
  h.listeners.get('#architecture')({ preventDefault() { prevented = true; } });
  assert.equal(prevented, true);
  assert.equal(h.scrolls[0].top, 328);
  assert.equal(h.scrolls[0].behavior, 'smooth');
  assert.equal(h.history[0][2], '#architecture');
});

test('empty or missing anchors leave browser navigation unchanged', () => {
  const h = harness();
  for (const name of ['#', '#missing']) {
    h.listeners.get(name)({ preventDefault() { assert.fail('unexpected navigation interception'); } });
  }
  assert.equal(h.scrolls.length, 0);
  assert.equal(h.history.length, 0);
});

test('browsers without IntersectionObserver retain anchor interaction', () => {
  const h = harness({ observer: false });
  assert.deepEqual(h.observed, []);
  h.listeners.get('#features')({ preventDefault() {} });
  assert.equal(h.scrolls.length, 1);
});

export const mainBehaviorContract = {
  // IntersectionObserver-based nav highlight
  navHighlight: {
    description:
      'When a section enters the viewport, the matching nav link gets the .is-active class',
    given: 'a viewport intersection at the #features section',
    when: 'the user scrolls so #features becomes the active section',
    then: 'the .primary-nav a[href="#features"] element has the .is-active class',
  },

  // Smooth scroll with header offset
  smoothScroll: {
    description:
      'Clicking a hash link scrolls to the target with the sticky header offset',
    given: 'a click on a[href="#architecture"] while the sticky header is 64px tall',
    when: 'the click event fires',
    then: 'window scrolls so the top of #architecture is at 64+8 = 72px from the viewport top',
  },

  // No auto-scroll on bare "#"
  noopHash: {
    description: 'Links with href="#" do not trigger any scroll',
    given: 'a link with href="#"',
    when: 'the link is clicked',
    then: 'the default behavior is NOT prevented; the browser handles it normally',
  },

  // Missing target is graceful
  missingTarget: {
    description: 'Clicking a link whose target does not exist does not throw',
    given: 'a link with href="#nonexistent"',
    when: 'the link is clicked',
    then: 'no error is thrown; the page does not scroll',
  },
};

export default mainBehaviorContract;
