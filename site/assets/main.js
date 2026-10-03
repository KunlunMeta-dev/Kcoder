// KCoder site — minimal vanilla JS
// Behavior contract: see assets/__tests__/main.spec.js

(() => {
  'use strict';

  // ---------- Active section tracking ----------
  const navLinks = Array.from(document.querySelectorAll('.primary-nav a[href^="#"]'));
  const sections = navLinks
    .map((link) => {
      const id = link.getAttribute('href').slice(1);
      return { id, link, el: document.getElementById(id) };
    })
    .filter((s) => s.el);

  if (sections.length && 'IntersectionObserver' in window) {
    const io = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (entry.isIntersecting) {
            const id = entry.target.id;
            for (const s of sections) {
              s.link.classList.toggle('is-active', s.id === id);
            }
          }
        }
      },
      { rootMargin: '-40% 0px -55% 0px', threshold: 0 }
    );
    for (const s of sections) io.observe(s.el);
  }

  // ---------- Smooth scroll with sticky-header offset ----------
  for (const link of document.querySelectorAll('a[href^="#"]')) {
    link.addEventListener('click', (ev) => {
      const href = link.getAttribute('href');
      if (!href || href === '#' || href.length < 2) return;
      const target = document.getElementById(href.slice(1));
      if (!target) return;
      ev.preventDefault();
      const headerH = document.querySelector('.site-header')?.offsetHeight ?? 0;
      const y = target.getBoundingClientRect().top + window.scrollY - headerH - 8;
      window.scrollTo({ top: y, behavior: 'smooth' });
      history.replaceState(null, '', href);
    });
  }
})();
