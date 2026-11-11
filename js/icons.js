/* Small local outline icon set. No fonts, CDN or emoji. */
(function(root){
  'use strict';
  const paths={
    grid:'M3 3h7v7H3z M14 3h7v7h-7z M3 14h7v7H3z M14 14h7v7h-7z',
    users:'M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2 M16 3a4 4 0 0 1 0 8 M22 21v-2a4 4 0 0 0-3-3.87 M13 7a4 4 0 1 1-8 0 4 4 0 0 1 8 0',
    chart:'M4 3v18h17 M9 16v-4 M14 16V8 M19 16V5',
    file:'M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z M14 2v6h6 M8 13h8 M8 17h6',
    settings:'M12 8a4 4 0 1 0 0 8 4 4 0 0 0 0-8 M12 2v3 M12 19v3 M2 12h3 M19 12h3 M5 5l2 2 M17 17l2 2 M5 19l2-2 M17 7l2-2',
    user:'M20 21v-2a6 6 0 0 0-6-6h-4a6 6 0 0 0-6 6v2 M16 5a4 4 0 1 1-8 0 4 4 0 0 1 8 0',
    shield:'M12 2 3 6v6c0 5 9 10 9 10s9-5 9-10V6z M8 12l3 3 5-6',
    plus:'M12 5v14 M5 12h14',
    search:'M21 21l-5-5 M18 10a8 8 0 1 1-16 0 8 8 0 0 1 16 0',
    refresh:'M20 7v5h-5 M4 17v-5h5 M6 6a8 8 0 0 1 13 2 M18 18a8 8 0 0 1-13-2',
    arrow:'M5 12h14 M13 6l6 6-6 6',
    download:'M12 3v12 M7 10l5 5 5-5 M4 16v5h16v-5',
    upload:'M12 16V4 M7 9l5-5 5 5 M4 16v5h16v-5',
    check:'M5 12l4 4L19 6',
    clock:'M12 7v5l3 2 M22 12a10 10 0 1 1-20 0 10 10 0 0 1 20 0',
    close:'M6 6l12 12 M6 18 18 6',
    mail:'M3 5h18v14H3z M3 6l9 7 9-7',
    link:'M10 13a5 5 0 0 0 7 0l3-3a5 5 0 0 0-7-7l-2 2 M14 11a5 5 0 0 0-7 0l-3 3a5 5 0 0 0 7 7l2-2',
    logout:'M9 3H3v18h6 M9 12h12 M16 7l5 5-5 5'
  };
  function icon(name){return `<svg class="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="${paths[name]||paths.file}"/></svg>`;}
  root.Icons={icon,mount(){document.querySelectorAll('[data-icon]').forEach(el=>{el.innerHTML=icon(el.dataset.icon);});}};
})(typeof window!=='undefined'?window:globalThis);
