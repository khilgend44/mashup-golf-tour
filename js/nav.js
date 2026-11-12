// Shared nav behaviour for every page using theme.css's .mu-nav / .mu-menu.
// Plain (non-module) script so any page can include it with one <script> tag.
//  - toggles the menu sheet (button #menu-btn, sheet #nav-menu), closes on outside tap / Escape
//  - marks the link for the current page with aria-current="page" (styled orange by theme.css)
(function () {
  var btn = document.getElementById('menu-btn');
  var menu = document.getElementById('nav-menu');
  if (!btn || !menu) return;

  function setOpen(open) {
    menu.hidden = !open;
    btn.setAttribute('aria-expanded', String(open));
    btn.innerHTML = open ? '&#10005;' : '&#9776;';
  }
  btn.addEventListener('click', function (e) { e.stopPropagation(); setOpen(menu.hidden); });
  document.addEventListener('click', function (e) { if (!menu.hidden && !menu.contains(e.target)) setOpen(false); });
  document.addEventListener('keydown', function (e) { if (e.key === 'Escape') setOpen(false); });

  // Cloudflare Pages may serve /season?id=… without ".html", so compare with it stripped.
  var norm = function (s) { return s.replace(/\.html(?=\?|$)/, ''); };
  var file = location.pathname.split('/').pop() || 'index.html';
  var here = norm(file + location.search);
  document.querySelectorAll('.mu-navlinks a, .mu-menu a').forEach(function (a) {
    if (norm(a.getAttribute('href') || '') === here) a.setAttribute('aria-current', 'page');
    else a.removeAttribute('aria-current');
  });
})();
