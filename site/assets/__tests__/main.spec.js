// Test contract for assets/main.js
//
// This is a hand-rolled spec that documents the expected behavior of
// assets/main.js. There is no test runner for the site (no build step),
// so this file acts as a human- and AI-readable contract. To execute it,
// load site/index.html in a browser and verify the assertions below.

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
