// Applies the saved theme before first paint. The key and shape match
// src/lib/state/settings.svelte.ts. A separate file so the CSP needs no inline script.
(function () {
  var root = document.documentElement;
  try {
    var s = JSON.parse(localStorage.getItem('sayl.settings') || '{}');
    var t = s.theme === 'auto' || s.theme === 'light' ? s.theme : 'dark';
    if (t !== 'auto') root.setAttribute('data-theme', t);
    if (s.reduceMotion === true) root.classList.add('rm');
  } catch (e) {
    root.setAttribute('data-theme', 'dark');
  }
})();
